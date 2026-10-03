import assert from "node:assert/strict";
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
  assert.match(text, /Namespace Sandbox\s+Yes/);
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
          body: Buffer.from("%PDF-1.4\nSynthetic invoice\n"),
        });
      return route.fulfill({
        contentType: "text/html",
        body: '<h1>Invoice history</h1><table><tr><td>September 5, 2026 USD 20.00</td><td><a href="/invoice.pdf">Download invoice PDF</a></td></tr></table><a href="/cancel">Cancel subscription</a><input type="password" value="synthetic-hidden"><script>fetch("/mutate",{method:"POST",body:"synthetic"}).catch(()=>{})</script>',
      });
    });
    return context;
  };
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
  const saved = await manager.call(user, id, { kind: "done" });
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
  console.log(
    JSON.stringify({
      nonRoot: true,
      namespaceSandbox: true,
      seccompSandbox: true,
      ownerIsolation: true,
      ownerOnlyInput: true,
      credentialsNotObserved: true,
      staleLinksRefused: true,
      realChromium: true,
      externalNetworkCalls: 0,
      modelCalls: 0,
    }),
  );
} finally {
  await browser.close();
}
