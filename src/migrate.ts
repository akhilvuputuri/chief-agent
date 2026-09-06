import "dotenv/config";
import { readFile } from "node:fs/promises";
import { connect } from "./db.js";
const db = connect(process.env.DATABASE_URL!);
try {
  await db.query(
    await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
  );
  console.log("Schema ready");
} finally {
  await db.end();
}
