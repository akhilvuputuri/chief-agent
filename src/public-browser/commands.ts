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

/** Who may browse: the one agent whose tools are this operation alone, on its own child run. */
export const BROWSER_AGENT = "core/browser";
export const PAGE_TEXT_LIMIT = 200_000;
/** Argv for the page's address. It reads location.href, which a page script cannot redefine. */
export const URL_ARGS = ["get", "url"];
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
