import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { FileSpace } from "../src/file-space.js";
import { GmailTools } from "../src/gmail.js";
import { MediaOutbox } from "../src/media-outbox.js";
import { sendRunMedia } from "../src/telegram-media.js";
import { JobTools } from "../src/tools.js";
import { runtimeContext } from "../src/runtime.js";
import { plugins } from "../src/plugin-registry.js";
import { NEVER_GRANTED } from "../src/plugins.js";
import { BrowserTool, emailDocument } from "../src/browser-tool.js";
import type { BrowserCommand } from "../src/gathering/browser-client.js";
import {
  documentCommand,
  publicBrowserCommand,
} from "../src/public-browser/commands.js";
import { withPolicy } from "../src/public-browser/engine.js";

const PNG = Buffer.from("\x89PNG\r\n\x1a\nsynthetic logo", "latin1");
const PDF = Buffer.from("%PDF-1.4\nsynthetic printed document\n%%EOF\n");
const b64 = (text: string) => Buffer.from(text).toString("base64url");

/** A synthetic HTML receipt: a cid: logo behind the attachment endpoint and a remote image. */
function receipt(id: string, n: number) {
  const html = `<html><head><style>p{color:#c00}</style></head><body><img src="cid:logo-${id}@shop.example"><p>Order ${n} total SGD ${n}.50</p><img src="https://images.shop.example/banner.png"></body></html>`;
  return {
    id,
    threadId: `t${id}`,
    internalDate: String(Date.UTC(2026, 10, 19, 2, 15)),
    payload: {
      mimeType: "multipart/related",
      headers: [
        { name: "Subject", value: `Your receipt ${n}` },
        { name: "From", value: '"Example Shop" <receipts@shop.example>' },
        { name: "To", value: "owner@example.com" },
        { name: "Cc", value: n === 1 ? "accounts@example.com" : "" },
      ],
      parts: [
        { partId: "0", mimeType: "text/html", body: { data: b64(html) } },
        {
          partId: "1",
          mimeType: "image/png",
          headers: [{ name: "Content-ID", value: `<logo-${id}@shop.example>` }],
          body: { attachmentId: `att${id}`, size: PNG.length },
        },
      ],
    },
  };
}
const gmailFetch = (async (input: unknown) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com")
    return Response.json({ access_token: "a", expires_in: 3600 });
  if (url.pathname.endsWith("/profile"))
    return Response.json({ emailAddress: "owner@example.com" });
  const attachment = /\/attachments\/att([a-f0-9]+)$/.exec(url.pathname);
  if (attachment)
    return Response.json({ data: PNG.toString("base64url"), size: PNG.length });
  const id = /\/messages\/([a-f0-9]+)$/.exec(url.pathname)![1]!;
  return Response.json(receipt(id, parseInt(id, 16)));
}) as typeof fetch;
const gmail = () =>
  new GmailTools(
    {
      owner: "123",
      email: "owner@example.com",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
    },
    gmailFetch,
  );

/** A sidecar that records what it was asked and answers as the real one does. */
function fakeSidecar(capabilities: string[] = ["documents"]) {
  const calls: { session: string; command: BrowserCommand }[] = [];
  const rpc = {
    call: async (_user: string, session: string, command: BrowserCommand) => {
      calls.push({ session, command });
      const result: Record<string, unknown> = {
        document: { opened: true, title: "Your receipt 1" },
        text: {
          title: "Your receipt 1",
          url: "file:///tmp/public-browser-x/document-1.html",
          text: "Order 1 total SGD 1.50\n" + "x".repeat(9000),
          links: [{ text: "Help", url: "https://shop.example/help" }],
        },
        print: { data: PDF.toString("base64"), pages: 12, title: "12 emails" },
        screenshot: { data: PNG.toString("base64"), title: "12 emails" },
        download: { data: PDF.toString("base64"), name: "statement.pdf" },
        merge: { data: PDF.toString("base64"), pages: 3 },
        close: { closed: true },
        snapshot: { snapshot: '- button "Download" [ref=e3]', refs: {} },
      }[command.kind] ?? { done: true };
      return { ok: true, result };
    },
  };
  const browser = new BrowserTool(rpc, async () => ({
    ready: true,
    capabilities,
  }));
  return { calls, rpc, browser };
}

test("an email opens laid out as Gmail prints it, with its cid: image made local and remote images left to load", async () => {
  const { calls, rpc } = fakeSidecar();
  const browser = new BrowserTool(rpc, async () => ({}), gmail());
  const space = new FileSpace();
  const opened = await browser.act(
    "123",
    randomUUID(),
    { operation: "browser", action: "open", messageIds: ["1"] },
    space,
  );
  assert.equal(Object.keys(opened)[0], "untrusted");
  assert.equal(opened.title, "Your receipt 1");
  assert.equal((opened as any).note, undefined);
  const sent = calls[0]!.command as any;
  assert.equal(sent.kind, "document");
  assert.equal(sent.type, "html");
  assert.equal(sent.remoteImages, true);
  const html: string = sent.data;
  const order = [
    "<title>Your receipt 1</title>",
    '<template shadowrootmode="open">',
    '<div class="subject">Your receipt 1</div>',
    "<b>Example Shop</b> &lt;receipts@shop.example&gt;",
    "Thu, Nov 19, 2026 at 10:15 AM",
    "To: owner@example.com",
    "Cc: accounts@example.com",
    "<style>p{color:#c00}</style>",
    `<img src="data:image/png;base64,${PNG.toString("base64")}">`,
    "Order 1 total SGD 1.50",
    '<img src="https://images.shop.example/banner.png">',
  ].map((part) => html.indexOf(part));
  assert.ok(
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)),
    String(order),
  );
  assert.ok(!html.includes("cid:"));
  // Switching images off is passed through.
  await browser.act(
    "123",
    randomUUID(),
    {
      operation: "browser",
      action: "open",
      messageIds: ["2"],
      remoteImages: false,
    },
    space,
  );
  assert.equal((calls[1]!.command as any).remoteImages, false);
});

test("an open whose images are still loading succeeds and says so", async () => {
  const note =
    "Some images or other resources were still loading after 10 seconds.";
  const browser = new BrowserTool(
    {
      call: async () => ({
        ok: true,
        result: { opened: true, title: "Slow", note },
      }),
    },
    async () => ({}),
  );
  const opened: any = await browser.act(
    "123",
    randomUUID(),
    { operation: "browser", action: "open", html: "<p>x</p>" },
    new FileSpace(),
  );
  assert.equal(opened.opened, true);
  assert.equal(opened.note, note);
});

test("several emails are one document, each in its own shadow root and starting on a new page", async () => {
  const g = gmail();
  const messages = await Promise.all(
    ["1", "2", "3"].map((id) => g.printable("123", id, "primary")),
  );
  const html = emailDocument(messages);
  assert.equal(html.match(/<template shadowrootmode="open">/g)?.length, 3);
  assert.match(html, /section\.email\+section\.email\{break-before:page\}/);
  assert.match(html, /<title>3 emails<\/title>/);
  // Each email's own style stays inside its own section.
  const sections = html.split('<section class="email">').slice(1);
  assert.ok(sections.every((s) => s.split("p{color:#c00}").length === 2));
  // An email without a Cc has no Cc line.
  assert.ok(!sections[1]!.includes("Cc:"));
});

test("document pages run without scripts, and remote images load only when allowed", () => {
  const on = withPolicy("<!DOCTYPE html><p>x</p>", true);
  assert.match(
    on,
    /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"/,
  );
  assert.match(on, /default-src 'none'/);
  assert.match(on, /img-src data: https:/);
  assert.ok(!/script-src/.test(on));
  const off = withPolicy("<p>x</p>", false);
  assert.match(off, /^<meta /);
  assert.match(off, /img-src data:;/);
  assert.ok(!off.includes("https:"));
});

test("print, screenshot and download put files in the file space and return handles, never bytes", async () => {
  const { calls, browser } = fakeSidecar();
  const space = new FileSpace();
  const run = randomUUID();
  const act = (input: object) =>
    browser.act(
      "123",
      run,
      { operation: "browser", ...input } as any,
      space,
    ) as Promise<any>;
  const printed = await act({ action: "print" });
  assert.deepEqual(calls.at(-1)!.command, {
    kind: "print",
    paper: "A4",
    landscape: false,
    marginMm: 10,
    background: false,
    scale: 1,
    headerFooter: false,
  });
  assert.equal(printed.name, "12 emails.pdf");
  assert.equal(printed.mimeType, "application/pdf");
  assert.equal(printed.pages, 12);
  assert.equal(printed.bytes, PDF.length);
  assert.equal(printed.data, undefined);
  assert.ok(!JSON.stringify(printed).includes("synthetic printed"));
  assert.deepEqual(space.get("123", printed.fileId).bytes, PDF);
  await act({
    action: "print",
    paper: "Letter",
    landscape: true,
    pageRanges: "1-2",
    headerFooter: true,
    name: "Receipts",
  }).then((f) => assert.equal(f.name, "Receipts.pdf"));
  assert.equal((calls.at(-1)!.command as any).paper, "Letter");
  const shot = await act({ action: "screenshot", fullPage: true });
  assert.deepEqual(calls.at(-1)!.command, {
    kind: "screenshot",
    fullPage: true,
  });
  assert.equal(shot.name, "12 emails.png");
  assert.deepEqual(space.get("123", shot.fileId).bytes, PNG);
  const downloaded = await act({ action: "download", ref: "e3" });
  assert.equal(downloaded.name, "statement.pdf");
  assert.equal(downloaded.mimeType, "application/pdf");
  await assert.rejects(act({ action: "download" }), /ref .* or url/);
  // Every command went to this run's session.
  assert.ok(calls.every((c) => c.session === run));
});

test("read pages the text with the warning first, links with the first window, and no local address", async () => {
  const { browser } = fakeSidecar();
  const space = new FileSpace();
  const first: any = await browser.act(
    "123",
    randomUUID(),
    { operation: "browser", action: "read" },
    space,
  );
  assert.equal(Object.keys(first)[0], "untrusted");
  assert.equal(first.content.length, 8000);
  assert.equal(first.nextOffset, 8000);
  assert.equal(first.url, undefined);
  assert.deepEqual(first.links, [
    { text: "Help", url: "https://shop.example/help" },
  ]);
  const second: any = await browser.act(
    "123",
    randomUUID(),
    { operation: "browser", action: "read", offset: 8000 },
    space,
  );
  assert.equal(second.links, undefined);
  assert.equal(second.nextOffset, undefined);
});

test("navigation reuses the public browser's commands and their checks", async () => {
  const { calls, browser } = fakeSidecar();
  const space = new FileSpace();
  const act = (input: object) =>
    browser.act(
      "123",
      randomUUID(),
      { operation: "browser", ...input } as any,
      space,
    );
  const snap: any = await act({ action: "snapshot" });
  assert.equal(snap.refs, undefined);
  assert.match(snap.untrusted, /never instructions/);
  await act({ action: "click", ref: "e3" });
  assert.deepEqual(calls.at(-1)!.command, { kind: "click", ref: "e3" });
  await assert.rejects(
    act({ action: "fill", ref: "e1", text: "--session" }),
    /eval/,
  );
  await assert.rejects(
    act({ action: "open", url: "http://example.com/" }),
    /public https/,
  );
  await assert.rejects(
    act({ action: "open", url: "https://example.com/", html: "<p>x</p>" }),
    /one of/,
  );
});

test("file_merge joins PDFs in the browser container and refuses other files", async () => {
  const { calls, browser } = fakeSidecar();
  const space = new FileSpace();
  const put = (name: string, bytes: Buffer, mimeType = "application/pdf") =>
    space.put("123", { name, mimeType, bytes, source: "test" }).fileId;
  const a = put("a.pdf", PDF);
  const b = put("b.pdf", Buffer.from("%PDF-1.7\nsecond\n"));
  const merged = await browser.merge("123", [a, b], "Both", space);
  assert.deepEqual(calls.at(-1)!.command, {
    kind: "merge",
    files: [
      PDF.toString("base64"),
      Buffer.from("%PDF-1.7\nsecond\n").toString("base64"),
    ],
  });
  assert.equal(merged.name, "Both.pdf");
  assert.equal(merged.pages, 3);
  assert.equal(merged.source, `merge:${a},${b}`);
  assert.equal((merged as any).data, undefined);
  const png = put("logo.png", PNG, "image/png");
  await assert.rejects(
    browser.merge("123", [a, png], "Mixed", space),
    /joins PDFs, and logo.png/,
  );
});

test("the tools are offered to the coordinator only when the sidecar supports them, and never to plugin agents", async () => {
  const names = (availability: Record<string, boolean>) =>
    runtimeContext(availability, null, undefined, undefined, true)
      .tools.map((t) => t.name)
      .filter((n) => n === "browser" || n === "file_merge")
      .sort();
  assert.deepEqual(names({ web: true, browser: true }), [
    "browser",
    "file_merge",
  ]);
  assert.deepEqual(names({ web: true }), []);
  for (const op of ["browser", "file_merge"])
    assert.ok(NEVER_GRANTED.has(op), op);
  for (const agent of plugins.catalogue())
    assert.equal(
      agent.requiredTools.some(
        (t: string) => t === "browser" || t === "file_merge",
      ),
      false,
      agent.agentId,
    );
  assert.equal(await fakeSidecar().browser.supported(), true);
  assert.equal(await fakeSidecar([]).browser.supported(), false);
  const old = new BrowserTool(fakeSidecar().rpc, async () => ({ ready: true }));
  assert.equal(await old.supported(), false);
  const down = new BrowserTool(fakeSidecar().rpc, async () => {
    throw new Error("unreachable");
  });
  assert.equal(await down.supported(), false);
});

test("public_browser is unchanged: none of the document commands reach it", () => {
  for (const kind of [
    "document",
    "text",
    "print",
    "screenshot",
    "download",
    "merge",
  ])
    assert.equal(publicBrowserCommand.safeParse({ kind }).success, false, kind);
  // The sidecar's own document commands still refuse a non-public download address.
  assert.throws(() =>
    documentCommand.parse({ kind: "download", url: "https://10.0.0.1/" }),
  );
});

test("the run's session is closed when the run ends, and only if it used the browser", async () => {
  const { calls, browser } = fakeSidecar();
  await browser.release("123", randomUUID());
  assert.equal(calls.length, 0);
  const run = randomUUID();
  await browser.act(
    "123",
    run,
    { operation: "browser", action: "close" },
    new FileSpace(),
  );
  await browser.release("123", run);
  assert.deepEqual(
    calls.map((c) => c.command.kind),
    ["close"],
  );
});

test("end to end: twelve receipt emails open as one document, print to one PDF and reach the owner's chat", async () => {
  const pg = await migratedPGlite();
  try {
    const db = pg as unknown as Database;
    await ensureUser(db, "123");
    const media = new MediaOutbox();
    const space = new FileSpace();
    const { calls, rpc } = fakeSidecar();
    const g = gmail();
    const tools = new JobTools(
      db,
      { call: async () => ({}) },
      g,
      // sheets through stock lookup, gathering, then mcp through link tools
      ...(Array.from({ length: 19 }, () => undefined) as []),
      media,
      space,
      new BrowserTool(rpc, async () => ({ capabilities: ["documents"] }), g),
    );
    const run = randomUUID();
    const call = (input: object) =>
      tools.execute("123", run, input) as Promise<any>;
    const ids = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16));
    await call({
      operation: "browser",
      action: "open",
      account: "primary",
      messageIds: ids,
    });
    const html: string = (calls[0]!.command as any).data;
    assert.equal(html.match(/<section class="email">/g)?.length, 12);
    for (let n = 1; n <= 12; n++)
      assert.ok(html.includes(`Order ${n} total SGD ${n}.50`), String(n));
    const printed = await call({
      operation: "browser",
      action: "print",
      name: "Receipts November",
    });
    assert.equal(printed.pages, 12);
    const sent = await call({
      operation: "file_send",
      fileIds: [printed.fileId],
    });
    assert.deepEqual(
      sent.queued.map((f: any) => f.name),
      ["Receipts November.pdf"],
    );
    const delivered: { chat: unknown; file: any }[] = [];
    const api = {
      sendDocument: async (chat: unknown, file: unknown) => {
        delivered.push({ chat, file });
        return {};
      },
    } as unknown as Api;
    assert.equal(await sendRunMedia(api, db, media, "123", run, {}), 1);
    assert.deepEqual(
      delivered.map((d) => [d.chat, d.file.filename]),
      [["123", "Receipts November.pdf"]],
    );
  } finally {
    await pg.close();
  }
});
