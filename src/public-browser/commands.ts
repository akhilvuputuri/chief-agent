import { z } from "zod";
import { publicHttps } from "../security.js";

// The whole surface the model can reach. agent-browser's cookie, state, auth, profile, upload,
// download, plugin and `read` commands stay unreachable: `read` fetches without the browser,
// so it would not pass through the egress proxy (docs/public-browser.md).
const ref = z.string().regex(/^@?e\d{1,6}$/);
export const publicBrowserCommand = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("open"),
      url: z.string().max(4000).transform(publicHttps),
    })
    .strict(),
  z.object({ kind: z.literal("snapshot") }).strict(),
  z
    .object({
      kind: z.literal("read"),
      offset: z.number().int().min(0).max(200_000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("click"), ref }).strict(),
  z
    .object({
      kind: z.literal("fill"),
      ref,
      // agent-browser reads a known flag here as an option and types a "--" separator
      // literally, so such text cannot reach its command line. eval can set that value.
      text: z
        .string()
        .max(4000)
        .refine((text) => !text.startsWith("-"), {
          message: "Text starting with - must be set with eval",
        }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("press"),
      key: z.string().regex(/^[A-Za-z0-9+]{1,30}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]),
      pixels: z.number().int().min(1).max(10_000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z
    .object({
      kind: z.literal("wait"),
      ms: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z
    .object({ kind: z.literal("eval"), js: z.string().min(1).max(8000) })
    .strict(),
  z.object({ kind: z.literal("close") }).strict(),
]);
export type PublicBrowserCommand = z.infer<typeof publicBrowserCommand>;

/** The request bound for document-carrying commands: an HTML email with its inline images. */
export const REQUEST_BYTES = 40_000_000;
/**
 * What the coordinator's `browser` tool adds (docs/public-browser.md): opening a document the
 * gateway supplies, page text with links, and turning the page into files. Never reachable
 * through `public_browser`, whose surface above is unchanged.
 */
export const documentCommand = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("document"),
      // HTML as text, or a PDF as base64.
      type: z.enum(["html", "pdf"]),
      data: z.string().min(1).max(REQUEST_BYTES),
      remoteImages: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("text") }).strict(),
  z
    .object({
      kind: z.literal("print"),
      paper: z.enum(["A4", "Letter", "Legal", "A3", "A5", "Tabloid"]),
      landscape: z.boolean(),
      marginMm: z.number().min(0).max(50),
      background: z.boolean(),
      scale: z.number().min(0.1).max(2),
      pageRanges: z
        .string()
        .regex(/^[\d\s,-]{1,100}$/)
        .optional(),
      headerFooter: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("screenshot"), fullPage: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("download"),
      ref: ref.optional(),
      url: z.string().max(4000).transform(publicHttps).optional(),
    })
    .strict(),
  // Joins PDFs with qpdf; needs no browser session.
  z
    .object({
      kind: z.literal("merge"),
      files: z.array(z.string().min(1).max(REQUEST_BYTES)).min(2).max(50),
    })
    .strict(),
]);
export type DocumentCommand = z.infer<typeof documentCommand>;
/** What the running sidecar can do beyond `public_browser`; the gateway offers tools by it. */
export const CAPABILITIES = ["documents"];

/** Who may browse: the one agent whose tools are this operation alone, on its own child run. */
export const BROWSER_AGENT = "core/browser";
export const PAGE_TEXT_LIMIT = 200_000;
/** Argv for the page's address. It reads location.href, which a page script cannot redefine. */
export const URL_ARGS = ["get", "url"];
/**
 * Page title, address, text and links. Text inside shadow roots (each email of an opened
 * email document is one) is added where the page's own text does not already hold it.
 */
export const TEXT_ARGS = (() => {
  const source = `(() => {
  const roots = [document];
  for (let i = 0; i < roots.length; i++)
    for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  const skip = new Set(["STYLE", "SCRIPT", "TEMPLATE", "TITLE", "META", "LINK"]);
  let text = document.body ? document.body.innerText : "";
  for (const root of roots.slice(1)) {
    const own = [...root.children].filter((c) => !skip.has(c.tagName)).map((c) => c.innerText).join("\\n").trim();
    if (own && !text.includes(own.slice(0, 200))) text += "\\n\\n" + own;
  }
  const links = [], seen = new Set();
  for (const root of roots)
    for (const a of root.querySelectorAll("a[href]")) {
      const url = a.href;
      if (links.length >= 500 || seen.has(url) || !/^(https?|mailto):/.test(url)) continue;
      seen.add(url);
      links.push({ text: (a.innerText || "").trim().slice(0, 120), url: url.slice(0, 4000) });
    }
  return { title: document.title, url: location.href, text: text.slice(0, ${PAGE_TEXT_LIMIT}), links };
})()`;
  return ["eval", "-b", Buffer.from(source, "utf8").toString("base64")];
})();
const js = (source: string) =>
  ["eval", "-b", Buffer.from(source, "utf8").toString("base64")] as const;

/** Argv after the global flags. Values are argv entries, never shell text. */
export function commandArgs(command: PublicBrowserCommand): string[] {
  switch (command.kind) {
    case "open":
      return ["open", command.url];
    case "snapshot":
      return ["snapshot", "-i", "-c", "--urls"];
    case "read":
      return [
        ...js(
          `(document.title+"\\n\\n"+(document.body?document.body.innerText:"")).slice(0,${PAGE_TEXT_LIMIT})`,
        ),
      ];
    case "click":
      return [
        "click",
        command.ref.startsWith("@") ? command.ref : `@${command.ref}`,
      ];
    case "fill":
      return [
        "fill",
        command.ref.startsWith("@") ? command.ref : `@${command.ref}`,
        command.text,
      ];
    case "press":
      return ["press", command.key];
    case "scroll":
      return ["scroll", command.direction, String(command.pixels ?? 600)];
    case "back":
      return ["back"];
    case "wait":
      return ["wait", String(command.ms)];
    case "eval":
      return [...js(command.js)];
    case "close":
      return ["close"];
  }
}
