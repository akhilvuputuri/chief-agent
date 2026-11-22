import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import type { Api } from "grammy";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { FileSpace, IDLE_MS } from "../src/file-space.js";
import { GmailTools } from "../src/gmail.js";
import { Gathering } from "../src/gathering/controller.js";
import { FileVault } from "../src/gathering/vault.js";
import { extractPdfText } from "../src/attachments.js";
import { MediaOutbox } from "../src/media-outbox.js";
import { sendRunMedia } from "../src/telegram-media.js";
import { JobTools } from "../src/tools.js";
import { runtimeContext } from "../src/runtime.js";
import { plugins } from "../src/plugin-registry.js";
import { NEVER_GRANTED } from "../src/plugins.js";

const MiB = 1024 * 1024;

test("the file space keeps files per owner, expires idle ones and drops the oldest past 100 MiB", () => {
  let now = 0;
  const space = new FileSpace(() => now);
  const put = (user: string, name: string, size = 10) =>
    space.put(user, {
      name,
      mimeType: "application/pdf",
      bytes: Buffer.alloc(size, 1),
      source: "test",
    });
  const a = put("owner", "a/b‮.pdf");
  assert.match(a.fileId, /^f-[a-f0-9]{12}$/);
  assert.equal(a.name, "a_b.pdf");
  put("other", "theirs.pdf");
  assert.deepEqual(
    space.list("owner").map((f) => [f.name, f.bytes, f.source, f.ageMinutes]),
    [["a_b.pdf", 10, "test", 0]],
  );
  assert.throws(() => space.get("other", a.fileId), /No file/);
  // Touching a file keeps it another hour; an untouched one expires.
  const b = put("owner", "b.pdf");
  now = IDLE_MS - 1;
  space.get("owner", a.fileId);
  now = IDLE_MS + 1;
  assert.deepEqual(
    space.list("owner").map((f) => f.fileId),
    [a.fileId],
  );
  assert.throws(() => space.get("owner", b.fileId), /expire an hour/);
  assert.throws(() => put("owner", "big", 20 * MiB + 1), /20 MiB/);
  // Past 100 MiB the least recently used go first.
  const big = [1, 2, 3, 4, 5].map((n) => put("owner", `big${n}`, 20 * MiB));
  assert.deepEqual(
    space.list("owner").map((f) => f.name),
    ["big1", "big2", "big3", "big4", "big5"],
  );
  space.get("owner", big[0]!.fileId);
  put("owner", "big6", 20 * MiB);
  assert.deepEqual(
    space.list("owner").map((f) => f.name),
    ["big3", "big4", "big5", "big1", "big6"],
  );
});

/** A one-page PDF, as tests/gathering.test.ts builds one. */
function pdf(text: string) {
  const body = `BT /F1 12 Tf 40 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
const PDF = pdf("Invoice total SGD 4.98");
const PNG = Buffer.from("\x89PNG\r\n\x1a\nnot really an image", "latin1");

/** Gmail with one message: a PDF behind the attachment endpoint and an inline PNG. */
const gmailFetch = (async (input: unknown) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com")
    return Response.json({ access_token: "a", expires_in: 3600 });
  if (url.pathname.endsWith("/profile"))
    return Response.json({ emailAddress: "owner@example.com" });
  if (url.pathname.endsWith("/messages/abc/attachments/att1"))
    return Response.json({ data: PDF.toString("base64url"), size: PDF.length });
  return Response.json({
    id: "abc",
    threadId: "fabc",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: "SGk", size: 2 } },
        {
          partId: "1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "att1", size: PDF.length },
        },
        {
          partId: "2",
          filename: "photo.png",
          mimeType: "image/png",
          body: { data: PNG.toString("base64url"), size: PNG.length },
        },
      ],
    },
  });
}) as typeof fetch;

/** The files of a stored ZIP, read from its local headers and checked against the directory. */
function unzip(zip: Buffer) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const files: { name: string; data: Buffer }[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x04034b50);
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const data = zip.subarray(
      at + 30 + nameLength,
      at + 30 + nameLength + size,
    );
    assert.equal(zip.readUInt32LE(at + 14), crc32(data));
    files.push({ name, data });
    at += 30 + nameLength + size;
  }
  assert.equal(zip.readUInt32LE(end + 16), at);
  return files;
}

test("an attachment taken to the file space can be zipped, sent to the owner's thread and kept in the vault", async () => {
  const pg = await migratedPGlite();
  try {
    const db = pg as unknown as Database;
    await ensureUser(db, "123");
    const vault = new FileVault(db, Buffer.alloc(32, 7));
    const media = new MediaOutbox();
    const space = new FileSpace();
    const tools = new JobTools(
      db,
      { call: async () => ({}) },
      new GmailTools(
        {
          owner: "123",
          email: "owner@example.com",
          clientId: "client",
          clientSecret: "secret",
          refreshToken: "refresh",
        },
        gmailFetch,
      ),
      // sheets, daily, calendar, library, library account, stocks, news,
      // responsibilities, coding, portfolio, stock lookup
      ...([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ] as const),
      ...([undefined, undefined, undefined, undefined, undefined] as const),
      new Gathering(db, vault),
      // mcp, links, singapore, mail index, embedder, public browser, link tools
      ...([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ] as const),
      media,
      space,
    );
    const run = randomUUID();
    const call = (input: object) =>
      tools.execute("123", run, input) as Promise<any>;

    // gmail_attachment with toFile returns a handle and facts, never the bytes or text.
    const pdfFile = await call({
      operation: "gmail_attachment",
      messageId: "abc",
      partId: "1",
      toFile: true,
    });
    assert.match(pdfFile.warning, /Untrusted email content/);
    assert.equal(pdfFile.name, "invoice.pdf");
    assert.equal(pdfFile.mimeType, "application/pdf");
    assert.equal(pdfFile.bytes, PDF.length);
    assert.equal(pdfFile.account, "primary");
    assert.equal(pdfFile.data, undefined);
    assert.equal(pdfFile.text, undefined);
    const image = await call({
      operation: "gmail_attachment",
      messageId: "abc",
      partId: "2",
      toFile: true,
    });
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(space.get("123", image.fileId).bytes, PNG);
    // Without toFile an image is still refused as having no text.
    await assert.rejects(
      call({ operation: "gmail_attachment", messageId: "abc", partId: "2" }),
      /no text to read/,
    );

    const listed = await call({ operation: "file_list" });
    assert.deepEqual(
      listed.files.map((f: any) => [f.name, f.bytes, f.source]),
      [
        ["invoice.pdf", PDF.length, "gmail:primary:abc:1"],
        ["photo.png", PNG.length, "gmail:primary:abc:2"],
      ],
    );
    assert.equal(JSON.stringify(listed).includes("PDF-1.4"), false);

    // file_zip makes a readable ZIP as a new file in the space.
    const zipped = await call({
      operation: "file_zip",
      fileIds: [pdfFile.fileId, image.fileId],
      name: "receipts",
    });
    assert.equal(zipped.name, "receipts.zip");
    assert.deepEqual(unzip(space.get("123", zipped.fileId).bytes), [
      { name: "invoice.pdf", data: PDF },
      { name: "photo.png", data: PNG },
    ]);

    // file_send queues documents that follow the reply in the owner's chat and thread.
    const sent = await call({
      operation: "file_send",
      fileIds: [pdfFile.fileId, zipped.fileId],
      caption: "Your receipts",
    });
    assert.deepEqual(
      sent.queued.map((f: any) => f.name),
      ["invoice.pdf", "receipts.zip"],
    );
    assert.match(sent.note, /right after your reply/);
    const delivered: { chat: unknown; file: any; options: any }[] = [];
    const api = {
      sendDocument: async (chat: unknown, file: unknown, options: unknown) => {
        delivered.push({ chat, file, options });
        return {};
      },
    } as unknown as Api;
    assert.equal(
      await sendRunMedia(api, db, media, "123", run, { message_thread_id: 9 }),
      2,
    );
    assert.deepEqual(
      delivered.map((d) => [
        d.chat,
        d.file.filename,
        d.options.message_thread_id,
        d.options.caption,
      ]),
      [
        ["123", "invoice.pdf", 9, "Your receipts"],
        ["123", "receipts.zip", 9, ""],
      ],
    );

    // file_save keeps a PDF under its own name with where it came from, and refuses a PNG.
    const kept = await call({
      operation: "file_save",
      fileId: pdfFile.fileId,
      name: "Store receipt October",
    });
    assert.equal(kept.name, "Store receipt October.pdf");
    assert.equal(kept.savedFrom, "gmail:primary:abc:1");
    const stored = await vault.read("123", kept.id);
    assert.deepEqual(stored.data, PDF);
    assert.equal(stored.facts.savedFrom, "gmail:primary:abc:1");
    await assert.rejects(
      call({ operation: "file_save", fileId: image.fileId }),
      /vault keeps PDFs only/,
    );
    // A PDF the reader cannot open (a password-protected statement, say) is still kept,
    // without text facts, and the call is not left uncertain.
    const locked = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Encrypt broken >>\nendobj\nnot a readable PDF",
    );
    await assert.rejects(extractPdfText(locked));
    const lockedFile = space.put("123", {
      name: "statement.pdf",
      mimeType: "application/pdf",
      bytes: locked,
      source: "gmail:primary:abc:3",
    });
    const keptLocked = await call({
      operation: "file_save",
      fileId: lockedFile.fileId,
    });
    assert.equal(keptLocked.name, "statement.pdf");
    assert.equal(keptLocked.textUnreadable, true);
    const storedLocked = await vault.read("123", keptLocked.id);
    assert.deepEqual(storedLocked.data, locked);
    assert.equal((storedLocked.facts as any).textUnreadable, true);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM tool_receipts WHERE operation='file_save' AND status='failed'",
        )
      ).rows[0].n,
      1, // the PNG refusal only
    );
  } finally {
    await pg.close();
  }
});

test("the coordinator is offered the file tools and plugin agents are not", () => {
  const names = (availability: Record<string, boolean>) =>
    runtimeContext(availability, null, undefined, undefined, true)
      .tools.map((t) => t.name)
      .filter((n) => n.startsWith("file_"))
      .sort();
  assert.deepEqual(names({ web: true, gmail: true, gathering: true }), [
    "file_list",
    "file_save",
    "file_send",
    "file_zip",
  ]);
  // file_save needs the vault, which comes with gathering.
  assert.deepEqual(names({ web: true }), [
    "file_list",
    "file_send",
    "file_zip",
  ]);
  for (const op of ["file_list", "file_send", "file_save", "file_zip"])
    assert.ok(NEVER_GRANTED.has(op), op);
  for (const agent of plugins.catalogue())
    assert.equal(
      agent.requiredTools.some((t: string) => t.startsWith("file_")),
      false,
      agent.agentId,
    );
});
