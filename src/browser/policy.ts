import { isIP } from "node:net";
import { publicHttps } from "../security.js";
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a !== undefined &&
      b !== undefined &&
      c !== undefined &&
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a < 224 &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0 || b === 88)) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase(),
      [first, second = "0"] = lower.split(":");
    if (!first || !/^2|^3/.test(first) || lower.includes(".")) return false;
    const a = parseInt(first, 16),
      b = parseInt(second, 16);
    return (
      a >= 0x2000 &&
      a <= 0x3fff &&
      a !== 0x2002 &&
      a !== 0x3fff &&
      !(a === 0x2001 && (b < 0x200 || b === 0xdb8))
    );
  }
  return false;
}
export function readUrl(input: string, origins?: string[]) {
  const u = new URL(publicHttps(input));
  if (/(^|\.)(nlb\.gov\.sg|overdrive\.com|libbyapp\.com)$/.test(u.hostname))
    throw new Error(
      "Library account/download routes are outside the invoice browser capability",
    );
  if (origins && !origins.includes(u.origin))
    throw new Error("Source origin needs owner handoff");
  const path = decodeURIComponent(u.pathname).toLowerCase();
  if (
    /cancel|delete|remove|logout|signout|unsubscribe|subscribe|checkout|purchase|upgrade|downgrade|confirm.?payment|change.?plan|(?:^|[/_-])pay(?:$|[/_-])/.test(
      path,
    ) ||
    [...u.searchParams.keys()].some((k) =>
      /^(action|mutation|method|command|cmd|operation)$/i.test(k),
    )
  )
    throw new Error("Account changes are not allowed");
  // A small positive document inventory. Unknown routes need live owner control.
  // The browser additionally blocks every background request while the agent controls it.
  if (
    !/^(?:\/|\/(?:settings\/|account\/)?billing(?:\/(?:history|invoices))?\/?|\/(?:account|invoices|receipts|statements|history|documents)\/?|\/(?:billing\/)?(?:invoices?|receipts?|statements?)\/(?:inv_[a-z0-9]+|[0-9a-f-]{8,})(?:\/download|\.pdf)?|\/[^/]+\.pdf)$/i.test(
      path,
    )
  )
    throw new Error("Unsupported read route; use owner handoff");
  if (
    [...u.searchParams.keys()].some(
      (k) =>
        !/^(?:page|cursor|before|after|month|year|download|format|token|signature|expires|x-amz-[a-z-]+)$/i.test(
          k,
        ),
    )
  )
    throw new Error("Unsupported read query; use owner handoff");
  return u.href;
}
export const invoiceLink = (name: string, url: string) =>
  /invoice|receipt|billing|statement|history|download|view|next|previous|older|newer|account|settings|documents|\.pdf(?:$|\?)/i.test(
    name + " " + new URL(url).pathname,
  ) &&
  !/\b(cancel|delete|remove|purchase|upgrade|downgrade|pay|subscribe|unsubscribe|checkout|ebook|borrow|loan|book)\b/i.test(
    name,
  );
export const safeLabel = (text: string) =>
  text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number omitted]")
    .replace(
      /\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}\b/g,
      "[credential omitted]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 160);
