import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Gathering } from "../src/gathering/controller.js";
import { FileVault } from "../src/gathering/vault.js";
import { action } from "../src/gathering/schema.js";
import { ensureUser, type Database } from "../src/db.js";
import { WorkTools } from "../src/work.js";
import { collectionZip, crc32 } from "../src/gathering/zip.js";
import { invoiceFacts } from "../src/gathering/facts.js";
import { publicAddress, readUrl } from "../src/browser/policy.js";
let pg: PGlite, db: Database, vault: FileVault, gather: Gathering;
function pdf(text: string) {
  const body = `BT /F1 12 Tf 40 720 Td (${text.replace(/[\\()]/g, (c) => "\\" + c)}) Tj ET`;
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
before(async () => {
  pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  db = pg as unknown as Database;
  vault = new FileVault(db, Buffer.alloc(32, 7));
  gather = new Gathering(db, vault);
  await ensureUser(db, "alice");
  await ensureUser(db, "bob");
});
after(async () => pg.close());
async function turn(user = "alice", request = "Gather invoices") {
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,$2,$3)",
    [run, user, request],
  );
  return run;
}
async function fixture(
  label = "ChatGPT",
  month = "2026-09",
  text = "OpenAI Invoice number INV-001 Invoice date September 5, 2026 USD 20.00",
) {
  const f = await vault.put(
    "alice",
    await vault.prepare("alice", "original.pdf", pdf(text)),
  );
  const run = await turn("alice", "Gather invoice " + f.id);
  const c = await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_start",
      requestKey: randomUUID(),
      objective: "Gather the selected invoice",
      targets: [{ key: "one", label, month }],
      sources: ["provided"],
      providedFiles: [f.id],
    }),
  );
  return { f, run, c };
}
test("PDF clues keep dates and amounts without payer/card/address content", () => {
  const f = invoiceFacts(
    "OpenAI Invoice number INV-7 September 5, 2026 USD 20.00 Bill to Alex Private 123 Main Street Account 1234567890 Card 4111 1111 1111 1111",
    1,
    false,
    ["ChatGPT"],
  );
  const text = JSON.stringify(f);
  assert.deepEqual(f.issuerLabels, ["ChatGPT"]);
  assert.ok(f.dates.includes("2026-09-05"));
  assert.doesNotMatch(text, /Alex Private|Main Street|1234567890|4111/);
  const service = invoiceFacts(
    "DigitalOcean Final invoice for September 2026 billing period Invoice date October 1, 2026 USD 12.00",
    1,
    false,
    ["DigitalOcean"],
  );
  assert.ok(service.serviceMonths.includes("2026-09"));
});
test("vault stores encrypted bytes, enforces owner binding and deduplicates exact PDFs", async () => {
  const f = await vault.prepare(
    "alice",
    "123 Main Street.pdf",
    pdf(
      "OpenAI Invoice number INV-99 September 5, 2026 USD 20.00 4111111111111111",
    ),
  );
  const a = await vault.put("alice", f),
    b = await vault.put("alice", f);
  assert.equal(a.id, b.id);
  assert.match(a.name, /^invoice-[a-f0-9]{16}\.pdf$/);
  const row = (
    await db.query("SELECT encrypted,facts FROM file_artifacts WHERE id=$1", [
      a.id,
    ])
  ).rows[0];
  assert.equal(
    Buffer.from(row.encrypted).includes(Buffer.from("4111111111111111")),
    false,
  );
  await assert.rejects(() => vault.read("bob", a.id), /unavailable/);
  assert.ok(
    (await vault.read("alice", a.id)).data.includes(Buffer.from("Invoice")),
  );
});
test("collection capture, scope coverage and completion are distinct and idempotent", async () => {
  const { f, run, c } = await fixture();
  const requestKey = randomUUID(),
    capture = action.parse({
      operation: "gather_capture",
      id: c.id,
      targetKey: "one",
      requestKey,
      source: { kind: "provided", artifactId: f.id },
    });
  const captured = await gather.call("alice", run, capture);
  assert.equal(captured.artifactId, f.id);
  assert.equal((await gather.call("alice", run, capture)).duplicate, true);
  await assert.rejects(
    () =>
      gather.call(
        "alice",
        run,
        action.parse({ ...capture, targetKey: "other" }),
      ),
    /Request key/,
  );
  await assert.rejects(() => gather.call("bob", awaitRun(), capture));
  function awaitRun() {
    return randomUUID();
  }
  const match = action.parse({
    operation: "gather_match",
    id: c.id,
    targetKey: "one",
    requestKey: randomUUID(),
    artifactId: f.id,
    date: "2026-09-05",
    dateBasis: "invoice_date",
  });
  await gather.call("alice", run, match);
  assert.equal((await gather.status("alice", c.id)).counts.covered, 0);
  assert.equal(
    (
      await gather.call(
        "alice",
        run,
        action.parse({
          operation: "gather_finish",
          id: c.id,
          requestKey: randomUUID(),
        }),
      )
    ).complete,
    false,
  );
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_check",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      source: "provided",
    }),
  );
  assert.equal((await gather.status("alice", c.id)).counts.covered, 1);
  const finished = await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_finish",
      id: c.id,
      requestKey: randomUUID(),
    }),
  );
  assert.equal(finished.complete, true);
  assert.equal(
    (await new WorkTools(db).snapshot("alice", c.taskId))?.task.status,
    "done",
  );
});
test("cross-task capture and invented document dates are refused", async () => {
  const { f, run, c } = await fixture();
  await assert.rejects(
    async () =>
      gather.call(
        "alice",
        await turn(),
        action.parse({
          operation: "gather_capture",
          id: c.id,
          targetKey: "one",
          requestKey: randomUUID(),
          source: { kind: "provided", artifactId: f.id },
        }),
      ),
    /not active/,
  );
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_capture",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      source: { kind: "provided", artifactId: f.id },
    }),
  );
  await assert.rejects(
    () =>
      gather.call(
        "alice",
        run,
        action.parse({
          operation: "gather_match",
          id: c.id,
          targetKey: "one",
          requestKey: randomUUID(),
          artifactId: f.id,
          date: "2026-09-20",
          dateBasis: "invoice_date",
        }),
      ),
    /recorded/,
  );
  await assert.rejects(
    () =>
      new WorkTools(db).call("alice", run, {
        operation: "work_step",
        id: c.taskId,
        key: "one",
        status: "done",
        result: "pretend",
        proofs: [],
      }),
    /host-checked/,
  );
});
test("owner scope revision preserves files while invalidating old scope proofs", async () => {
  const { f, run, c } = await fixture();
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_capture",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      source: { kind: "provided", artifactId: f.id },
    }),
  );
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_match",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      artifactId: f.id,
      date: "2026-09-05",
      dateBasis: "invoice_date",
    }),
  );
  const revised = await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_revise",
      id: c.id,
      baseRevision: 1,
      requestKey: randomUUID(),
      objective: "Gather October instead",
      targets: [{ key: "one", label: "ChatGPT", month: "2026-10" }],
      sources: ["provided"],
      providedFiles: [f.id],
    }),
  );
  assert.equal(revised.revision, 2);
  const snapshot = await gather.status("alice", c.id);
  assert.equal(snapshot.counts.covered, 0);
  assert.equal(snapshot.targets[0]?.month, "2026-10");
  assert.equal(snapshot.targets[0]?.state, "pending");
  assert.equal(snapshot.counts.expected, 1);
  assert.equal(snapshot.targets[0]?.files.length, 0);
  assert.ok(await vault.read("alice", f.id));
  await assert.rejects(
    () =>
      gather.call(
        "alice",
        run,
        action.parse({
          operation: "gather_match",
          id: c.id,
          targetKey: "one",
          requestKey: randomUUID(),
          artifactId: f.id,
          date: "2026-10-05",
          dateBasis: "invoice_date",
        }),
      ),
    /recorded/,
  );
});
test("service-period months can be matched without inventing an invoice day", async () => {
  const { f, run, c } = await fixture(
    "DigitalOcean",
    "2026-09",
    "DigitalOcean Invoice number DO-9 Final invoice for September 2026 billing period Invoice date October 1, 2026 USD 12.00",
  );
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_revise",
      id: c.id,
      baseRevision: 1,
      requestKey: randomUUID(),
      objective: "Gather September usage",
      targets: [
        {
          key: "one",
          label: "DigitalOcean",
          month: "2026-09",
          dateBasis: "service_period",
        },
      ],
      sources: ["provided"],
      providedFiles: [f.id],
    }),
  );
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_capture",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      source: { kind: "provided", artifactId: f.id },
    }),
  );
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_match",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      artifactId: f.id,
      date: "2026-09",
      dateBasis: "service_period",
    }),
  );
  assert.equal(
    (await gather.status("alice", c.id)).targets[0]?.files[0]?.date,
    "2026-09",
  );
});
test("ZIP contains only current-scope matched files and correct CRCs", async () => {
  const { f, run, c } = await fixture();
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_capture",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      source: { kind: "provided", artifactId: f.id },
    }),
  );
  const empty = Buffer.concat(
    await Array.fromAsync(collectionZip(gather, "alice", c.id)),
  );
  assert.equal(empty.readUInt16LE(8), 0);
  await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_match",
      id: c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      artifactId: f.id,
      date: "2026-09-05",
      dateBasis: "invoice_date",
    }),
  );
  const zip = Buffer.concat(
    await Array.fromAsync(collectionZip(gather, "alice", c.id)),
  );
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const raw = await vault.read("alice", f.id);
  assert.equal(zip.readUInt32LE(14), crc32(raw.data));
});
test("public egress and agent navigation refuse private/special ranges and account actions", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.2",
    "192.168.0.1",
    "100.64.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002:7f00:1::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(publicAddress(ip), true, ip);
  for (const url of [
    "https://billing.example.com/cancel",
    "https://billing.example.com/a?mutation=delete",
    "https://127.0.0.1/a",
  ])
    assert.throws(() => readUrl(url));
  assert.equal(
    readUrl("https://billing.example.com/invoices"),
    "https://billing.example.com/invoices",
  );
});
