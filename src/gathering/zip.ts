import type { Gathering } from "./controller.js";
import { fileName } from "./facts.js";
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** ZIP stored entries, streamed one bounded PDF at a time. No user paths, compression bombs or executable files. */
export async function* collectionZip(
  gather: Gathering,
  user: string,
  id: string,
): AsyncGenerator<Buffer> {
  const rows = (
    await gather.db.query(
      "SELECT DISTINCT a.id,a.name FROM gather_items g JOIN gather_collections c ON c.id=g.collection_id AND c.user_id=g.user_id JOIN file_artifacts a ON a.id=g.artifact_id AND a.user_id=g.user_id WHERE g.collection_id=$1 AND g.user_id=$2 AND g.scope_revision=c.task_revision ORDER BY a.id",
      [id, user],
    )
  ).rows;
  const central: Buffer[] = [];
  let offset = 0,
    index = 0;
  for (const row of rows) {
    const file = await gather.vault.read(user, row.id),
      name = Buffer.from(
        `${String(++index).padStart(3, "0")}-${fileName(file.name)}`,
        "utf8",
      ),
      crc = crc32(file.data),
      size = file.data.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));
    yield header;
    yield name;
    yield file.data;
    offset += header.length + name.length + size;
  }
  const directory = Buffer.concat(central);
  yield directory;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(rows.length, 8);
  end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
