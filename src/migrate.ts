import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { connect } from "./db.js";
const db = connect(process.env.DATABASE_URL!);
try {
  const directory = new URL("../db/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort()) {
    await db.query(await readFile(new URL(file, directory), "utf8"));
  }
  console.log("Schema ready");
} finally {
  await db.end();
}
