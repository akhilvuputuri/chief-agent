// Provision a private app-owned workbook once, outside the model tool boundary.
import { readFile, writeFile } from "node:fs/promises";
const [tokenPath, outputPath] = process.argv.slice(2);
if (!tokenPath || !outputPath)
  throw Error(
    "Usage: node scripts/create-preparation-sheet.mjs TOKEN_JSON SHEET_JSON",
  );
// Fail before creating anything if this setup already has an output file.
try {
  await readFile(outputPath);
  throw Error("Output already exists; reuse the existing sheet");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const c = JSON.parse(await readFile(tokenPath, "utf8"));
async function request(url, body, token) {
  const r = await fetch(url, {
    method: "POST",
    body: token ? JSON.stringify(body) : new URLSearchParams(body),
    headers: token
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      : {},
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw Error(`Google request failed (${r.status})`);
  return r.json();
}
const t = await request("https://oauth2.googleapis.com/token", {
  client_id: c.client_id,
  client_secret: c.client_secret,
  refresh_token: c.refresh_token,
  grant_type: "refresh_token",
});
const sheet = await request(
  "https://sheets.googleapis.com/v4/spreadsheets",
  {
    properties: { title: "Companion Agent — Preparation" },
    sheets: ["Target roles", "Preparation gaps", "Preparation tasks"].map(
      (title, sheetId) => ({
        properties: {
          title,
          sheetId,
          gridProperties: {
            rowCount: 1000,
            columnCount: 20,
            frozenRowCount: 1,
          },
        },
      }),
    ),
  },
  t.access_token,
);
await writeFile(
  outputPath,
  JSON.stringify({
    spreadsheetId: sheet.spreadsheetId,
    url: sheet.spreadsheetUrl,
    email: c.email,
  }),
  { mode: 0o600, flag: "wx" },
);
console.log(sheet.spreadsheetUrl);
