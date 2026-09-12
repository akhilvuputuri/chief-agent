import { inspectMemory } from "../dist/memory-inspect.js";
import pg from "pg";
const [target = "recent", mode = "metadata"] = process.argv.slice(2);
if (!["metadata", "full"].includes(mode))
  throw new Error("Expected metadata or full");
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(
    JSON.stringify(
      await inspectMemory(
        db,
        process.env.GMAIL_OWNER_USER_ID,
        target,
        mode === "full",
      ),
    ),
  );
} finally {
  await db.end();
}
