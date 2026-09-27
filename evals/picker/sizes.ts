// Prints the schema characters of each tool group for the picker eval:
// {"core": n, "domains": {domain: n}, "full": n}. No network, no secrets.
import { runtimeContext } from "../../src/runtime.js";
import { domainOf, TOOL_DOMAINS } from "../../src/tool-domains.js";

const { tools } = runtimeContext(
  {
    web: true,
    gmail: true,
    calendar: true,
    preparationSheet: true,
    dailySheet: true,
    canvases: true,
    library: true,
    libraryAccount: true,
    parcels: true,
    stocks: true,
  },
  null,
  undefined,
  new Set(TOOL_DOMAINS),
);
let core = 0;
const domains: Record<string, number> = Object.fromEntries(
  TOOL_DOMAINS.map((d) => [d, 0]),
);
for (const tool of tools) {
  const chars = JSON.stringify(tool).length;
  const domain = domainOf(tool.name);
  if (domain) domains[domain] = (domains[domain] ?? 0) + chars;
  else core += chars;
}
console.log(
  JSON.stringify({ core, domains, full: JSON.stringify(tools).length }),
);
