// Only typed invoice clues cross the model/history boundary. Original documents stay in the encrypted owner vault.
export type InvoiceFacts = {
  pages: number;
  truncated: boolean;
  selectableText: boolean;
  invoiceHeading: boolean;
  dates: string[];
  invoiceDates: string[];
  serviceDates: string[];
  serviceMonths: string[];
  amounts: { currency: string; amount: string }[];
  invoiceNumbers: string[];
  issuerLabels: string[];
};
const aliases: Record<string, string[]> = {
  chatgpt: ["openai"],
  claude: ["anthropic"],
  anthropic: ["anthropic"],
  digitalocean: ["digitalocean", "digital ocean"],
};
export function issuerTerms(label: string) {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...new Set([label.toLowerCase(), ...(aliases[normalized] ?? [])])];
}
function iso(y: number, m: number, d: number) {
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const date = new Date(s + "T00:00:00Z");
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === s
    ? s
    : undefined;
}
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
export function datesIn(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const s = iso(+m[1]!, +m[2]!, +m[3]!);
    if (s) out.add(s);
  }
  // Avoid ambiguous numeric day/month formats. Month names and ISO dates are unambiguous.
  for (const m of text.matchAll(
    /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/g,
  )) {
    const month = months.findIndex((x) => x.startsWith(m[1]!.toLowerCase()));
    const s = iso(+m[3]!, month + 1, +m[2]!);
    if (month >= 0 && s) out.add(s);
  }
  for (const m of text.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(20\d{2})\b/g,
  )) {
    const month = months.findIndex((x) => x.startsWith(m[2]!.toLowerCase()));
    const s = iso(+m[3]!, month + 1, +m[1]!);
    if (month >= 0 && s) out.add(s);
  }
  return [...out].sort().slice(0, 60);
}
export function monthsIn(text: string) {
  const found = new Set(datesIn(text).map((d) => d.slice(0, 7)));
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\s+(20\d{2})\b/g)) {
    const month = months.findIndex((x) => x.startsWith(m[1]!.toLowerCase()));
    if (month >= 0) found.add(m[2] + "-" + String(month + 1).padStart(2, "0"));
  }
  return [...found].sort().slice(0, 36);
}
export function invoiceFacts(
  text: string,
  pages: number,
  truncated: boolean,
  labels: string[] = [],
): InvoiceFacts {
  const lower = text.toLowerCase();
  const amounts = [
    ...text.matchAll(
      /\b(USD|SGD|EUR|GBP|AUD|CAD|JPY|INR|MYR|HKD|NZD)\s*([0-9]{1,9}(?:\.[0-9]{1,4})?)\b/g,
    ),
  ]
    .slice(0, 30)
    .map((m) => ({ currency: m[1]!, amount: m[2]! }));
  const invoiceNumbers = [
    ...new Set(
      [
        ...text.matchAll(
          /\b(?:invoice|receipt)\s*(?:number|no\.?|#|id)\s*:?\s*([A-Za-z0-9][A-Za-z0-9_-]{0,60})\b/gi,
        ),
      ]
        .map((m) => m[1]!)
        .filter(
          (x) =>
            !/^\d{13,19}$/.test(x) && !/(?:sk-|ghp_|github_pat_|AKIA)/.test(x),
        )
        .slice(0, 12),
    ),
  ];
  const serviceBlocks = [
    ...text.matchAll(
      /(?:service|billing)\s*period[^\n]{0,120}|final invoice for[^\n]{0,120}/gi,
    ),
  ].map(
    (m) =>
      m[0].split(
        /invoice\s+(?:date|number)|date\s+of\s+issue|due\s+date|total|amount|bill\s+to/i,
      )[0]!,
  );
  const serviceDates = serviceBlocks.flatMap(datesIn);
  const invoiceDates = [
    ...text.matchAll(
      /(?:invoice\s+date|date\s+(?:of\s+issue|issued)|issued\s+on|issue\s+date|receipt\s+date)\s*:?\s*([^\n]{0,60})/gi,
    ),
  ].flatMap((m) =>
    datesIn(
      m[1]!.split(
        /due\s+date|service\s+period|billing\s+period|total|amount|bill\s+to/i,
      )[0]!,
    ),
  );
  return {
    pages,
    truncated,
    selectableText: text.replace(/--- Page \d+ ---/g, "").trim().length >= 20,
    invoiceHeading: /\b(invoice|receipt|tax invoice)\b/i.test(text),
    dates: datesIn(text),
    invoiceDates: [...new Set(invoiceDates)].slice(0, 20),
    serviceDates: [...new Set(serviceDates)].slice(0, 30),
    serviceMonths: [...new Set(serviceBlocks.flatMap(monthsIn))].slice(0, 36),
    amounts,
    invoiceNumbers,
    issuerLabels: [...new Set(labels)]
      .filter((label) =>
        issuerTerms(label).some((term) => lower.includes(term)),
      )
      .slice(0, 36),
  };
}
export function fileName(name: string) {
  return (
    (
      name
        .replace(/[\x00-\x1f\x7f\\/]/g, "_")
        .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
        .trim()
        .slice(0, 110) || "invoice"
    ).replace(/\.pdf$/i, "") + ".pdf"
  );
}
