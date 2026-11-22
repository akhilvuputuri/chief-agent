#!/usr/bin/env node
// Proves the public browser's confinement from inside its own container, through the real
// engine. Run it in the candidate image on the public-browser network, optionally naming a
// decoy service whose own log must then show no request (docs/public-browser.md).
//
//   node public-browser-probe.mjs [http://decoy:8080] [https://decoy.dotted.example/]
//
// The second decoy is what can falsify the proxy's HTTPS policy: a dotted name resolving to a
// private address, with something listening on 443, so a broken policy really connects.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import {
  mergePdfs,
  PublicBrowserEngine,
} from "./dist/public-browser/engine.js";
import {
  documentCommand,
  publicBrowserCommand as schema,
} from "./dist/public-browser/commands.js";

const proxy = process.env.BROWSER_PROXY ?? "http://public-browser-proxy:3002";
const decoy = process.argv[2];
const httpsDecoy = process.argv[3];
const engine = new PublicBrowserEngine(proxy);
const session = "00000000-0000-4000-8000-000000000001";
const call = (command) => engine.call("probe", session, schema.parse(command));
const evaluate = async (js) => (await call({ kind: "eval", js })).result;
const processes = () =>
  readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((pid) => {
      try {
        // Chromium rewrites its children's titles into one string, so match on the whole line.
        const line = readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .replaceAll("\0", " ")
          .trim();
        return line ? [{ pid, line }] : [];
      } catch {
        return [];
      }
    });
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

const opened = await call({ kind: "open", url: "https://example.com/" });
check(
  "opens a public page through the proxy",
  opened.url === "https://example.com/",
);
const snapshot = await call({ kind: "snapshot" });
check(
  "lists interactive elements",
  String(snapshot.snapshot).includes("ref=e1"),
);
const page = await call({ kind: "read" });
check(
  "reads page text with its address, unscripted",
  String(page.result).includes("Example Domain") &&
    page.url === "https://example.com/" &&
    page.scripted === false,
);
check(
  "runs JavaScript",
  (await evaluate("document.title")) === "Example Domain",
);
check(
  "a read after a script is marked as scripted",
  (await call({ kind: "read" })).scripted === true,
);
// Every other command the model can send, through the real command line.
await evaluate(
  `document.body.innerHTML='<input id="f" aria-label="field"><button onclick="document.title=&quot;clicked&quot;">go</button><div style="height:5000px"></div>'`,
);
const form = String((await call({ kind: "snapshot" })).snapshot);
const refOf = (role) =>
  form.match(new RegExp(`${role}[^\\n]*ref=(e\\d+)`))?.[1];
const typed = "a -b  --session c";
await call({ kind: "fill", ref: refOf("textbox"), text: typed });
check(
  "text is typed exactly",
  (await evaluate("document.getElementById('f').value")) === typed,
);
check(
  "text that could be read as a flag is refused",
  !schema.safeParse({ kind: "fill", ref: "e1", text: "--session" }).success,
);
await call({ kind: "press", key: "Tab" });
await call({ kind: "click", ref: refOf("button") });
check("clicks an element", (await evaluate("document.title")) === "clicked");
await call({ kind: "scroll", direction: "down", pixels: 700 });
check("scrolls the page", Number(await evaluate("window.scrollY")) > 0);
await call({ kind: "open", url: "https://example.com/?second" });
await call({ kind: "back" });
await call({ kind: "wait", ms: 500 });
check("goes back", !String(await evaluate("location.href")).includes("second"));

const browserLine = /chromium|agent-browser/;
const browsers = processes().filter((p) => browserLine.test(p.line));
check(
  "Chromium is running",
  browsers.some((p) => /chromium/.test(p.line)),
);
check(
  "no browser process has --no-sandbox",
  !browsers.some((p) => p.line.includes("--no-sandbox")),
);
const renderer = browsers.find((p) => p.line.includes("--type=renderer"));
check("a renderer is running", !!renderer);
const status = (pid) => readFileSync(`/proc/${pid}/status`, "utf8");
check(
  "renderer runs under a seccomp filter",
  !!renderer && /^Seccomp:\s+2$/m.test(status(renderer.pid)),
);
const namespace = (pid, kind) => {
  try {
    return readlinkSync(`/proc/${pid}/ns/${kind}`);
  } catch {
    return "unreadable";
  }
};
check(
  "renderer is in its own PID namespace",
  !!renderer && namespace(renderer.pid, "pid") !== namespace("self", "pid"),
);
const heldKey = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").includes(
      "BROWSER_CONTROL_KEY",
    );
  } catch {
    return false;
  }
};
check(
  "browser processes do not hold the control key",
  browsers.length > 0 && !browsers.some((p) => heldKey(p.pid)),
);

const navigate = async (target) => {
  await evaluate(`location.href=${JSON.stringify(target)}`).catch(() => {});
  await call({ kind: "wait", ms: 1500 });
};
const PROXY_REFUSAL = "HTTPS only";
const profile = readdirSync("/tmp").find((n) =>
  n.startsWith("public-browser-"),
);
const debugPort = readFileSync(
  `/tmp/${profile}/profile/DevToolsActivePort`,
  "utf8",
).split("\n")[0];
// Plain HTTP: only the proxy's refusal may come back, so these fail if the proxy is bypassed.
for (const target of [
  "http://127.0.0.1:3001/healthz",
  "http://localhost:3001/healthz",
  `http://127.0.0.1:${debugPort}/json/version`,
  "http://169.254.169.254/latest/meta-data/",
  ...(decoy ? [decoy] : []),
]) {
  const name = `plain HTTP gets the proxy's refusal: ${target}`;
  // A page that hangs is a failure of this target, and must not hide the ones after it.
  try {
    await navigate(target);
    const body = String(
      await evaluate("document.body?document.body.innerText:''"),
    ).trim();
    check(name, body === PROXY_REFUSAL, body.slice(0, 40));
  } catch (error) {
    check(name, false, String(error.message).slice(0, 60));
  }
}
// HTTPS: the proxy's destination policy, which the plain HTTP handler above never reaches.
// From a real page each time, so a navigation left hanging fails instead of reading an old error.
for (const target of [
  "https://169.254.169.254/latest/meta-data/",
  "https://127.0.0.1/",
  `https://127.0.0.1:${debugPort}/json/version`,
  "https://10.0.0.1/",
  ...(httpsDecoy ? [httpsDecoy] : []),
]) {
  const name = `HTTPS destination did not load: ${target}`;
  try {
    await call({ kind: "open", url: "https://example.com/" });
    await navigate(target);
    const landed = String(await evaluate("location.href"));
    check(name, landed.startsWith("chrome-error:"), landed.slice(0, 40));
  } catch (error) {
    check(name, false, String(error.message).slice(0, 60));
  }
}
await call({ kind: "open", url: "https://example.com/" });
await evaluate("location.href='file:///etc/passwd'").catch(() => {});
await call({ kind: "wait", ms: 1000 });
check(
  "page cannot open local files",
  !String(await evaluate("location.href")).startsWith("file:"),
);
const direct = await fetch("https://example.com/", {
  signal: AbortSignal.timeout(8000),
}).then(
  () => "reached",
  () => "refused",
);
check("the container has no direct internet route", direct === "refused");
const memory = () =>
  Math.round(
    Number(readFileSync("/sys/fs/cgroup/memory.peak", "utf8")) / 1048576,
  );
console.log(`memory peak so far: ${memory()} MiB`);

// The coordinator's browser tool: documents the gateway supplies, printed, captured and joined.
const doc = (command) =>
  engine.call("probe", session, documentCommand.parse(command));
// A 1x1 PNG, as an email's inline cid: image arrives once the gateway has made it local.
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const email = (n, style) =>
  `<section class="email"><template shadowrootmode="open"><style>${style}</style><div class="subject">Synthetic receipt ${n}</div><p>Order ${n} total SGD ${n}.50</p><img src="data:image/png;base64,${pixel}"></template></section>`;
const emails = `<!doctype html><html><head><meta charset="utf-8"><title>2 emails</title><style>body{margin:0}section.email+section.email{break-before:page}</style><script>document.title="scripted"</script></head><body>${email(1, "p{color:rgb(204,0,0)}")}${email(2, "")}</body></html>`;
const pdfText = async (base64) => {
  const pdf = await getDocumentProxy(
    new Uint8Array(Buffer.from(base64, "base64")),
  );
  return (await extractText(pdf, { mergePages: false })).text;
};
try {
  const opened = await doc({
    kind: "document",
    type: "html",
    data: emails,
    remoteImages: true,
  });
  check(
    "a supplied email document opens with scripts off",
    opened.title === "2 emails",
  );
  const text = await doc({ kind: "text" });
  check(
    "its text is read from both emails, once each",
    String(text.text).split("Order 1 total").length === 2 &&
      String(text.text).split("Order 2 total").length === 2,
    String(text.text).slice(0, 80),
  );
  const colour = await evaluate(
    `getComputedStyle(document.querySelectorAll("section")[1].shadowRoot.querySelector("p")).color`,
  );
  check(
    "one email's styles do not reach another",
    colour !== "rgb(204, 0, 0)",
    colour,
  );
  const printed = await doc({
    kind: "print",
    paper: "A4",
    landscape: false,
    marginMm: 10,
    background: false,
    scale: 1,
    headerFooter: false,
  });
  const pages = await pdfText(printed.data);
  check(
    "print gives a real PDF, one email per page",
    Buffer.from(printed.data, "base64").subarray(0, 5).toString() === "%PDF-" &&
      printed.pages === 2 &&
      pages.length === 2 &&
      pages[0].includes("Synthetic receipt 1") &&
      pages[1].includes("Synthetic receipt 2") &&
      pages[1].includes("Order 2 total SGD 2.50"),
    `${printed.pages} pages: ${pages.map((p) => p.slice(0, 30)).join(" | ")}`,
  );
  const shot = await doc({ kind: "screenshot", fullPage: true });
  check(
    "a screenshot is a PNG",
    Buffer.from(shot.data, "base64").subarray(1, 4).toString() === "PNG",
  );
  const merged = await mergePdfs([printed.data, printed.data]);
  check(
    "qpdf joins two PDFs into one",
    merged.pages === 4 && (await pdfText(merged.data)).length === 4,
  );
} catch (error) {
  check(
    "the document commands work",
    false,
    String(error.message).slice(0, 80),
  );
}
const fonts = execFileSync("fc-list", [":", "family"], { encoding: "utf8" });
for (const family of [
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "Noto Sans",
  "Noto Sans CJK",
  "Noto Color Emoji",
])
  check(`font installed: ${family}`, fonts.includes(family));

await call({ kind: "close" });
await new Promise((resolve) => setTimeout(resolve, 1500));
check(
  "closing leaves no browser or daemon behind",
  !processes().some((p) => browserLine.test(p.line)),
);
check(
  "closing leaves no session files behind",
  !readdirSync("/tmp").some((name) => name.startsWith("public-browser-")),
);
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("All confinement checks passed");
process.exit(0);
