import { readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const path = new URL("../.env", import.meta.url);
let template = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const password = randomBytes(32).toString("hex");
template = template.replaceAll("replace-with-random-password", password);
try {
  await writeFile(path, template, { flag: "wx", mode: 0o600 });
  console.log(
    "Created private .env with generated database credentials. Fill in provider keys and Telegram identity locally.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  await chmod(path, 0o600);
  console.log(
    "Existing .env preserved; file permissions restricted to your account.",
  );
}
