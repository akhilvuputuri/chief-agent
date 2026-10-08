import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import { BrowserManager } from "./dist/browser/manager.js";
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  executablePath: "/usr/bin/chromium",
});
try {
  assert.notEqual(process.getuid(), 0);
  const sandbox = await browser.newPage();
  await sandbox.goto("chrome://sandbox");
  const text = await sandbox.locator("body").innerText();
  assert.ok(
    /Namespace Sandbox\s+Yes/.test(text) ||
      /Layer 1 Sandbox\s+Namespace/.test(text),
  );
  assert.match(text, /PID namespaces\s+Yes/);
  assert.match(text, /Network namespaces\s+Yes/);
  assert.notEqual(
    spawnSync("/usr/sbin/chroot", ["/", "/usr/bin/true"]).status,
    0,
  );
  assert.match(text, /Seccomp-BPF sandbox\s+Yes/);
  await sandbox.close();
  const manager = new BrowserManager("http://127.0.0.1:9", async () => browser);
  // Inject only synthetic page data. No actual account, network, key or paid model is used.
  const original = browser.newContext.bind(browser);
  let context;
  let observedPosts = 0;
  browser.newContext = async (options) => {
    context = await original(options);
    await context.route("https://billing.example.com/**", async (route) => {
      if (route.request().method() !== "GET") {
        observedPosts++;
        return route.fulfill({ status: 200, body: "synthetic owner request" });
      }
      const path = new URL(route.request().url()).pathname;
      if (path === "/invoice.pdf")
        return route.fulfill({
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename=invoice.pdf",
          },
          body: pdf,
        });
      return route.fulfill({
        contentType: "text/html",
        body: '<h1>Invoice history</h1><table><tr><td>September 5, 2026 USD 20.00</td><td><a href="/invoice.pdf">Download invoice PDF</a></td></tr></table><a href="/cancel">Cancel subscription</a><input type="password" value="synthetic-hidden"><script>fetch("/mutate",{method:"POST",body:"synthetic"}).catch(()=>{})</script>',
      });
    });
    return context;
  };
  const pdf = Buffer.from("%PDF-1.4\nSynthetic owner-only invoice download\n");
  const user = "synthetic",
    id = "00000000-0000-4000-8000-000000000001";
  const opened = await manager.call(user, id, {
    kind: "open",
    url: "https://billing.example.com/",
    origins: ["https://billing.example.com"],
  });
  assert.equal(opened.needsOwner, true);
  assert.equal(observedPosts, 0);
  assert.equal(JSON.stringify(opened).includes("synthetic-hidden"), false);
  assert.equal(JSON.stringify(opened).includes("/cancel"), false);
  await assert.rejects(() => manager.call("other", id, { kind: "observe" }));
  await manager.call(user, id, { kind: "await_owner" });
  await assert.rejects(() =>
    manager.call(user, id, { kind: "text", text: "should not be inserted" }),
  );
  await manager.call(user, id, { kind: "owner" });
  const frame = await manager.call(user, id, { kind: "frame" });
  assert.equal(frame.width, 1280);
  const downloaded = context.pages()[0].waitForEvent("download");
  await context
    .pages()[0]
    .getByRole("link", { name: "Download invoice PDF" })
    .click();
  await downloaded;
  const saved = await manager.call(user, id, { kind: "done" });
  const files = await manager.call(user, id, { kind: "downloads" });
  assert.equal(files.files.length, 1);
  const originalPdf = await manager.call(user, id, {
    kind: "owner_file",
    id: files.files[0].id,
  });
  assert.deepEqual(Buffer.from(originalPdf.data, "base64"), pdf);
  await manager.call(user, id, { kind: "ack_file", id: files.files[0].id });
  assert.equal(typeof saved.storageState, "string");
  await assert.rejects(() =>
    manager.call(user, id, { kind: "text", text: "after handoff" }),
  );
  const observed = await manager.call(user, id, { kind: "observe" });
  await assert.rejects(() =>
    manager.call(user, id, {
      kind: "follow",
      snapshotId: opened.snapshotId,
      linkId: observed.links[0].id,
    }),
  );
  await manager.call(user, id, { kind: "close" });
  let mutationRequests = 0;
  browser.newContext = async (options) => {
    assert.equal(options.storageState, undefined);
    assert.equal(options.acceptDownloads, false);
    const ctx = await original(options);
    await ctx.route("https://www.reddit.com/**", async (route) => {
      if (route.request().method() !== "GET") mutationRequests++;
      return route.fulfill({
        contentType: "text/html",
        body: '<shreddit-post id="t3_abc123" post-type="link" content-href="https://publisher.example.com/story"></shreddit-post><a href="https://ad.example.com">Advertisement</a><script>fetch("/api/vote",{method:"POST"}).catch(()=>{})</script>',
      });
    });
    return ctx;
  };
  const publicManager = new BrowserManager(
    "http://127.0.0.1:9",
    async () => browser,
  );
  const publicResult = await publicManager.call(
    user,
    "00000000-0000-4000-8000-000000000002",
    {
      kind: "resolve_public",
      url: "https://www.reddit.com/r/worldnews/comments/abc123/story/",
    },
  );
  assert.equal(publicResult.postId, "abc123");
  assert.deepEqual(publicResult.outbound, [
    "https://publisher.example.com/story",
  ]);
  assert.equal(mutationRequests, 0);
  let publicContexts = 0;
  let mode = "duplicate";
  browser.newContext = async (options) => {
    publicContexts++;
    const ctx = await original(options);
    await ctx.route("https://www.reddit.com/**", async (route) => {
      if (mode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.abort().catch(() => {});
        return;
      }
      return route.fulfill({
        contentType: "text/html",
        body: '<!-- <shreddit-post id="t3_abc123" content-href="https://fake.example.com"></shreddit-post> --><shreddit-post id="t3_abc123" content-href="https://one.example.com"></shreddit-post><shreddit-post id="t3_abc123" content-href="https://two.example.com"></shreddit-post>',
      });
    });
    return ctx;
  };
  const duplicateManager = new BrowserManager(
    "http://127.0.0.1:9",
    async () => browser,
  );
  const duplicate = await duplicateManager.call(user, crypto.randomUUID(), {
    kind: "resolve_public",
    url: "https://www.reddit.com/comments/abc123/story/",
  });
  assert.equal(duplicate.blocked, true);
  mode = "slow";
  publicContexts = 0;
  const cancelManager = new BrowserManager(
    "http://127.0.0.1:9",
    async () => browser,
  );
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const active = cancelManager.call(
    user,
    crypto.randomUUID(),
    {
      kind: "resolve_public",
      url: "https://www.reddit.com/comments/abc123/story/",
    },
    activeAbort.signal,
  );
  const queued = cancelManager.call(
    user,
    crypto.randomUUID(),
    {
      kind: "resolve_public",
      url: "https://www.reddit.com/comments/abc123/story/",
    },
    queuedAbort.signal,
  );
  // Attach rejection handlers before issuing cancellation.
  const activeRejected = assert.rejects(active);
  const queuedRejected = assert.rejects(queued);
  await new Promise((resolve) => setTimeout(resolve, 100));
  queuedAbort.abort();
  activeAbort.abort();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(publicContexts, 1);
  assert.equal(browser.contexts().length, 0);
  console.log(
    JSON.stringify({
      nonRoot: true,
      namespaceSandbox: true,
      hostChrootDenied: true,
      originalOwnerDownload: true,
      seccompSandbox: true,
      ownerIsolation: true,
      ownerOnlyInput: true,
      credentialsNotObserved: true,
      staleLinksRefused: true,
      realChromium: true,
      isolatedPublicResolution: true,
      publicCancellation: true,
      conflictingPostRefused: true,
      externalNetworkCalls: 0,
      modelCalls: 0,
    }),
  );
} finally {
  await browser.close();
}
