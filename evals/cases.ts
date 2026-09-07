export const fixtureVersion = "1";
export const cases = [
  "collection",
  "missing-evidence",
  "scope-change",
] as const;
export type CaseName = (typeof cases)[number];
export function records(name: CaseName) {
  return Array.from({ length: name === "collection" ? 22 : 3 }, (_, i) => ({
    id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    company: `Fixture Company ${i + 1}`,
    title: `Platform Engineer ${i + 1}`,
    url: `https://fixtures.example/roles/${i + 1}`,
    description:
      "Requires TypeScript. Customer deployment experience is required. " +
      (name === "collection"
        ? "Office information and general company background. ".repeat(140)
        : ""),
  }));
}
export function prompt(name: CaseName) {
  return `Evaluate ${name === "scope-change" ? "only IDs 10000000-0000-4000-8000-000000000001 and 10000000-0000-4000-8000-000000000002 from the" : "all"} saved roles against my explicitly saved background. Read each exact posting. Do not substitute recommended jobs. Missing background evidence is unknown, not a gap. ${name === "collection" ? "Track this substantial task and persist findings incrementally." : ""}
For this evaluation, your final response must be a JSON object with complete (boolean) and items (array). Each item has id (exact saved UUID), title (exact saved title), assessment (strength, gap, or unknown for customer deployment experience), and reason. Account for every requested role. Do not save new roles or change their status.`;
}
export const followup =
  "Change the scope: exclude ID 10000000-0000-4000-8000-000000000001 and evaluate only IDs 10000000-0000-4000-8000-000000000002 and 10000000-0000-4000-8000-000000000003. Return the same JSON format with just those two roles; preserve uncertainty.";
