import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
const envPath = new URL("../.env", import.meta.url);
const pairPath = new URL("../.telegram-pairing.json", import.meta.url);
const source = await readFile(envPath, "utf8");
const env = parse(source);
async function api(method) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    { signal: AbortSignal.timeout(15000) },
  );
  const data = await response.json();
  if (!data.ok)
    throw new Error(
      "Telegram request failed. Check credentials and stop any competing bot poller.",
    );
  return data.result;
}
try {
  if (!process.argv.includes("--finish")) {
    const bot = await api("getMe");
    const code = "pair_" + randomBytes(16).toString("hex");
    await writeFile(
      pairPath,
      JSON.stringify({ code, expires: Date.now() + 15 * 60 * 1000 }),
      { mode: 0o600 },
    );
    console.log(
      `Open https://t.me/${bot.username}?start=${code} and press Start. Then run npm run pair:finish within 15 minutes.`,
    );
  } else {
    const pairing = JSON.parse(await readFile(pairPath, "utf8"));
    if (pairing.expires < Date.now())
      throw new Error("Pairing expired; run npm run pair again.");
    const updates = await api("getUpdates");
    const matches = new Set(
      updates
        .filter(
          (update) =>
            update.message?.chat?.type === "private" &&
            update.message?.text === `/start ${pairing.code}`,
        )
        .map((update) => String(update.message.from.id)),
    );
    if (matches.size !== 1)
      throw new Error(
        "No unique matching private message yet. Open the pairing link and press Start.",
      );
    const id = [...matches][0];
    const ids = new Set(
      (env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").filter(Boolean),
    );
    ids.add(id);
    await writeFile(
      envPath,
      source.replace(
        /^TELEGRAM_ALLOWED_USER_IDS=.*$/m,
        `TELEGRAM_ALLOWED_USER_IDS=${[...ids].join(",")}`,
      ),
      { mode: 0o600 },
    );
    await unlink(pairPath);
    console.log(
      "Your Telegram account is now allowlisted. Pairing did not send a message or start the agent.",
    );
  }
} catch (error) {
  console.error(
    error.message?.startsWith("Telegram") ||
      error.message?.startsWith("Pairing") ||
      error.message?.startsWith("No unique")
      ? error.message
      : "Pairing could not finish; no credentials were logged.",
  );
  process.exitCode = 1;
}
