import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Gathering } from "../dist/gathering/controller.js";
import { FileVault } from "../dist/gathering/vault.js";
import { GatheringBrowsers } from "../dist/gathering/sessions.js";
import { action } from "../dist/gathering/schema.js";
import { BrowserManager } from "../dist/browser/manager.js";
import { privateInvoiceIntake, invoiceFacts } from "../dist/gathering/facts.js";
const root = new URL("../", import.meta.url).pathname;
function pdf(text) {
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

async function fixture({
  accountLabel,
  browser = false,
  text = "OpenAI Invoice number INV-001 Invoice date September 5, 2026 USD 20.00 Bill to Personal account",
} = {}) {
  const db = new PGlite();
  for (const f of (await readdir(root + "/db"))
    .filter((x) => x.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(root + "/db/" + f, "utf8"));
  await db.query("INSERT INTO users(id) VALUES('alice'),('bob')");
  const vault = new FileVault(db, Buffer.alloc(32, 7)),
    data = pdf(text);
  const file = await vault.put(
    "alice",
    await vault.prepare("alice", "original.pdf", data),
  );
  const browsers = browser
    ? {
        download: async () => ({
          name: "invoice.pdf",
          data,
          origin: "https://billing.example.com",
        }),
        closeCollection: async () => {},
      }
    : undefined;
  const gather = new Gathering(db, vault, undefined, browsers),
    run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'alice',$2)",
    [run, "Gather invoice " + file.id],
  );
  const c = await gather.call(
    "alice",
    run,
    action.parse({
      operation: "gather_start",
      requestKey: randomUUID(),
      objective: "Gather exact requested invoice",
      targets: [
        {
          key: "one",
          label: "ChatGPT",
          month: "2026-09",
          ...(accountLabel ? { accountLabel } : {}),
        },
      ],
      sources: [browser ? "browser" : "provided"],
      providedFiles: browser ? [] : [file.id],
    }),
  );
  const call = (a) =>
    gather.call(
      "alice",
      run,
      action.parse({
        id: c.id,
        targetKey: "one",
        requestKey: randomUUID(),
        ...a,
      }),
    );
  const capture = () =>
    call({
      operation: "gather_capture",
      source: browser
        ? {
            kind: "browser",
            sessionId: randomUUID(),
            snapshotId: randomUUID(),
            linkId: randomUUID(),
          }
        : { kind: "provided", artifactId: file.id },
    });
  const match = () =>
    call({
      operation: "gather_match",
      artifactId: file.id,
      date: "2026-09-05",
      dateBasis: "invoice_date",
    });
  return { db, vault, gather, run, c, file, call, capture, match };
}
test("account-constrained target cannot match a different account invoice", async () => {
  const f = await fixture({ accountLabel: "Business" });
  try {
    await f.capture();
    await assert.rejects(f.match, /account has not been verified/);
    await assert.rejects(
      () => f.gather.verifyAccount("bob", f.c.id, "one", f.file.id, 1),
      /changed/,
    );
    await f.gather.verifyAccount("alice", f.c.id, "one", f.file.id, 1);
    assert.equal((await f.match()).matched, true);
  } finally {
    await f.db.close();
  }
});
test("capturing the same PDF twice cannot satisfy two-invoice browser coverage", async () => {
  const f = await fixture({ browser: true });
  try {
    await f.capture();
    await f.capture();
    await f.match();
    await f.db.query(
      "INSERT INTO gather_attempts(id,user_id,collection_id,target_key,kind,state,metadata,scope_revision) VALUES($1,'alice',$2,'one','browser','success',$3::jsonb,1)",
      [
        randomUUID(),
        f.c.id,
        JSON.stringify({ ownerConfirmedCount: 2, month: "2026-09" }),
      ],
    );
    await assert.rejects(
      () => f.call({ operation: "gather_check", source: "browser" }),
      /count|confirmed/i,
    );
    assert.equal((await f.gather.status("alice", f.c.id)).counts.files, 1);
  } finally {
    await f.db.close();
  }
});
test("mutation retry from a different delegated task cannot read another collection", async () => {
  const f = await fixture();
  try {
    const req = action.parse({
      operation: "gather_capture",
      id: f.c.id,
      targetKey: "one",
      requestKey: randomUUID(),
      source: { kind: "provided", artifactId: f.file.id },
    });
    await f.gather.call("alice", f.run, req);
    const child = randomUUID();
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'alice','different assignment')",
      [child],
    );
    await f.db.query(
      "INSERT INTO events(run_id,user_id,type,data) VALUES($1,'alice','agent.child_started','{}')",
      [child],
    );
    await assert.rejects(
      () => f.gather.call("alice", child, req),
      /assignment|active|scope/,
    );
  } finally {
    await f.db.close();
  }
});
test("an unreadable supplied PDF keeps source coverage unresolved", async () => {
  const f = await fixture();
  try {
    const blank = await f.vault.put(
      "alice",
      await f.vault.prepare("alice", "scanned.pdf", pdf("")),
    );
    await f.db.query(
      "UPDATE work_turns SET request=request||$2 WHERE run_id=$1",
      [f.run, " " + blank.id],
    );
    await f.gather.call(
      "alice",
      f.run,
      action.parse({
        operation: "gather_revise",
        id: f.c.id,
        baseRevision: 1,
        requestKey: randomUUID(),
        objective: "Gather both supplied PDFs",
        targets: [{ key: "one", label: "ChatGPT", month: "2026-09" }],
        sources: ["provided"],
        providedFiles: [f.file.id, blank.id],
      }),
    );
    await f.capture();
    await f.call({
      operation: "gather_capture",
      source: { kind: "provided", artifactId: blank.id },
    });
    await f.match();
    await assert.rejects(
      () => f.call({ operation: "gather_check", source: "provided" }),
      /unknown relevance|unreadable/,
    );
  } finally {
    await f.db.close();
  }
});
test("cancel during owner done cannot commit browser authentication profile or success", async () => {
  const f = await fixture({ browser: true });
  try {
    const sid = randomUUID();
    await f.db.query(
      "INSERT INTO gather_browser_sessions(id,user_id,collection_id,target_key,origin,state,allowed_origins) VALUES($1,'alice',$2,'one','https://billing.example.com','owner','[\"https://billing.example.com\"]')",
      [sid, f.c.id],
    );
    const client = {
      call: async (_u, _id, c) => {
        if (c.kind === "done") {
          await f.db.query(
            "UPDATE work_tasks SET status='cancelled' WHERE id=$1",
            [f.c.taskId],
          );
          return {
            storageState: JSON.stringify({
              cookies: [{ name: "synthetic", value: "synthetic" }],
            }),
            origins: ["https://billing.example.com"],
          };
        }
        if (c.kind === "downloads") return { files: [] };
        throw Error(c.kind);
      },
    };
    const browsers = new GatheringBrowsers(f.db, Buffer.alloc(32, 7), client);
    let result;
    try {
      result = await browsers.owner("alice", sid, {
        kind: "done",
        remember: true,
      });
    } catch {}
    const profiles = (
      await f.db.query("SELECT count(*) AS n FROM gather_browser_profiles")
    ).rows[0].n;
    console.log("cancel-during-done", { result, profiles });
    assert.equal(Number(profiles), 0);
    assert.ok(!result?.saved);
  } finally {
    await f.db.close();
  }
});
async function fakeManager(links = []) {
  let routeHandler;
  const seenCookies = [];
  const page = {
    on() {},
    url: () => "https://billing.example.com/invoices",
    goto: async () => {},
    evaluate: async () => ({ text: "Invoice history", login: false, links }),
    isClosed: () => false,
  };
  const context = {
    newPage: async () => page,
    route: async (_pat, handler) => {
      routeHandler = handler;
    },
    routeWebSocket: async () => {},
    on() {},
    close: async () => {},
    cookies: async (url) => {
      seenCookies.push(url);
      throw Error("foreign cookie lookup reached");
    },
  };
  const manager = new BrowserManager("http://unused", async () => ({
    newContext: async () => context,
    close: async () => {},
  }));
  const id = randomUUID();
  const opened = await manager.call("alice", id, {
    kind: "open",
    url: "https://billing.example.com/invoices",
    origins: ["https://billing.example.com"],
  });
  return { manager, id, opened, route: () => routeHandler, seenCookies };
}
test("browser PDF downloads enforce the same granted origin as navigation", async () => {
  const f = await fakeManager([
    {
      url: "https://unrequested.example.com/invoice.pdf",
      name: "Download invoice",
      row: "September 5, 2026",
    },
  ]);
  const ref = { snapshotId: f.opened.snapshotId, linkId: f.opened.links[0].id };
  await assert.rejects(
    () => f.manager.call("alice", f.id, { kind: "follow", ...ref }),
    /owner handoff/,
  );
  await assert.rejects(
    () => f.manager.call("alice", f.id, { kind: "download", ...ref }),
    /owner handoff/,
  );
  assert.equal(f.seenCookies.length, 0);
});
test("read-only browser rejects a GET account mutation route", async () => {
  const f = await fakeManager();
  let allowed = false,
    aborted = false;
  await f.route()({
    request: () => ({
      url: () => "https://billing.example.com/api/billing/cancelSubscription",
      method: () => "GET",
      resourceType: () => "fetch",
      isNavigationRequest: () => false,
    }),
    fallback: async () => {
      allowed = true;
    },
    abort: async () => {
      aborted = true;
    },
  });
  console.log("GET account mutation route", { allowed, aborted });
  assert.equal(allowed, false);
});

test("private invoice intake does not depend on a recognized provider", () => {
  const facts = invoiceFacts(
    "GitHub Invoice number GH-001 Invoice date September 5, 2026 USD 20.00 Bill to Private Owner",
    1,
    false,
    ["ChatGPT", "Anthropic", "DigitalOcean"],
  );
  assert.deepEqual(facts.issuerLabels, []);
  assert.equal(privateInvoiceIntake("", facts, false), true);
  assert.equal(
    privateInvoiceIntake("", invoiceFacts("", 1, false), true),
    true,
  );
  assert.equal(
    privateInvoiceIntake(
      "my resume",
      invoiceFacts("Resume experience", 1, false),
      false,
    ),
    false,
  );
});
