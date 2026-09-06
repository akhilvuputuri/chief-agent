// One-time local OAuth bootstrap. Never prints credentials, codes or token responses.
import { validateSheetsScopes } from "./google-sheets-scopes.mjs";
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const [clientPath, outputPath, email] = process.argv.slice(2);
if (!clientPath || !outputPath || !email)
  throw new Error(
    "Usage: node scripts/connect-sheets.mjs CLIENT_JSON OUTPUT_JSON EMAIL",
  );
const client = JSON.parse(await readFile(clientPath, "utf8")).installed;
if (!client?.client_id || !client?.client_secret)
  throw new Error("Desktop OAuth client required");
const scope =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file";
const state = randomBytes(32).toString("base64url"),
  verifier = randomBytes(48).toString("base64url");
let busy = false,
  redirect;
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/plain");
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname != "/callback" || req.method !== "GET") {
    res.writeHead(404).end();
    return;
  }
  const received = Buffer.from(u.searchParams.get("state") || "");
  if (
    received.length !== state.length ||
    !timingSafeEqual(received, Buffer.from(state))
  ) {
    res.writeHead(400).end("Invalid authorization state");
    return;
  }
  if (busy) {
    res.writeHead(409).end();
    return;
  }
  busy = true;
  try {
    if (u.searchParams.has("error") || !u.searchParams.get("code"))
      throw new Error("Consent not completed");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code: u.searchParams.get("code"),
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new Error("Token exchange failed");
    const t = await response.json();
    validateSheetsScopes(t.scope);
    if (!t.refresh_token || !t.access_token) throw new Error("Offline authorization was not returned. Restart consent.");
    const profile = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${t.access_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (
      !profile.ok ||
      (await profile.json()).email?.toLowerCase() !== email.toLowerCase()
    )
      throw new Error("Wrong Google account");
    await writeFile(
      outputPath,
      JSON.stringify({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: t.refresh_token,
        email,
        scope,
      }),
      { mode: 0o600, flag: "wx" },
    );
    res.end("App-created Sheets authorization saved. You can close this tab.");
    console.log("App-created Sheets authorization saved successfully.");
  } catch (error) {
    const safeMessages = ["Missing file permission. Select the files-you-use-with-this-app checkbox on Google consent.", "Unexpected Google permissions. Setup stopped without saving credentials.", "Offline authorization was not returned. Restart consent.", "Consent not completed", "Token exchange failed", "Wrong Google account"];
    const message = safeMessages.includes(error?.message) ? error.message : "Authorization failed during account verification or credential storage. Restart setup.";
    res.writeHead(400).end(message);
    console.error(message);
  } finally {
    clearTimeout(timer);
    server.close();
  }
});
const timer = setTimeout(() => server.close(), 15 * 60 * 1000);
server.listen(0, "127.0.0.1", () => {
  redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    login_hint: email,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  console.log(u.toString());
});
