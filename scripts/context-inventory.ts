// Measures the fixed model-input envelope: instructions, runtime state and
// per-tool schemas, in characters. Offline: uses repository definitions only,
// no owner data, database or provider calls. Issue #77, stage 1.
import { instructions } from "../src/context.js";
import { runtimeContext } from "../src/runtime.js";
import { selectDomains } from "../src/tool-domains.js";

const allOn = {
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
};
const runtime = runtimeContext(allOn, null);
const tools = runtime.tools.map((t) => ({
  name: t.name,
  chars: JSON.stringify(t).length,
  description: t.description.length,
  parameters: JSON.stringify(t.parameters).length,
}));
tools.sort((a, b) => b.chars - a.chars);
const toolTotal = JSON.stringify(runtime.tools).length;
const domain = (n: string) =>
  n.split("_")[0]!.replace(/^(prep|sheet)$/, "preparation");
const byDomain = new Map<string, { tools: number; chars: number }>();
for (const t of tools) {
  const d = domain(t.name);
  const e = byDomain.get(d) ?? { tools: 0, chars: 0 };
  e.tools++;
  e.chars += t.chars;
  byDomain.set(d, e);
}
const out = {
  instructionsChars: instructions.length,
  runtimeContextChars_withoutOwnerState: runtime.context.length,
  toolCount: tools.length,
  toolSchemasChars: toolTotal,
  byDomain: [...byDomain.entries()]
    .map(([d, e]) => ({ domain: d, ...e }))
    .sort((a, b) => b.chars - a.chars),
  largestTools: tools.slice(0, 15),
};
// Stage 2: tool schemas and runtime state offered for representative first
// messages, with every integration enabled (repository definitions only).
const scenarios: [string, Parameters<typeof selectDomains>[0]][] = [
  ["plain chat", { message: "hello, how are you?" }],
  ["email lookup", { message: "any new email from the bank this week?" }],
  ["calendar", { message: "what's on my calendar tomorrow?" }],
  ["job preparation", { message: "prep me for the interview at the company" }],
  ["image", { message: "what is this?\n\n[Attached image: a.png]" }],
  ["background task", { message: "continue", taskBound: true }],
];
const scenarioSizes = scenarios.map(([name, signals]) => {
  const domains = selectDomains(signals);
  const limited = runtimeContext(allOn, null, undefined, domains);
  return {
    scenario: name,
    domains: [...domains].sort(),
    tools: limited.tools.length,
    toolSchemasChars: JSON.stringify(limited.tools).length,
    runtimeContextChars: limited.context.length,
  };
});
console.log(
  JSON.stringify(
    {
      ...out,
      fullToolSchemasChars: toolTotal,
      fullRuntimeContextChars: runtime.context.length,
      scenarios: scenarioSizes,
    },
    null,
    2,
  ),
);
