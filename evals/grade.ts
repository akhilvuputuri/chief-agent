export const graderVersion = "1";
export function grade(
  reply: string,
  expected: { id: string; title: string }[],
) {
  let parsed: any;
  try {
    parsed = JSON.parse(
      reply
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim(),
    );
  } catch {
    /* invalid output is explicitly scored */
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const ids = items.map((x: any) => x?.id);
  const expectedIds = new Set(expected.map((x) => x.id));
  const unexpected = ids.filter((x: any) => !expectedIds.has(x));
  const missing = expected.filter((x) => !ids.includes(x.id)).map((x) => x.id);
  const identityErrors = items.filter(
    (x: any) => expected.find((y) => y.id === x.id)?.title !== x.title,
  ).length;
  const duplicates = ids.length - new Set(ids).size;
  const unknownsPreserved =
    items.length > 0 && items.every((x: any) => x.assessment === "unknown");
  const structureValid =
    typeof parsed?.complete === "boolean" &&
    Array.isArray(parsed?.items) &&
    items.every(
      (x: any) =>
        typeof x?.id === "string" &&
        typeof x?.title === "string" &&
        typeof x?.reason === "string" &&
        x.reason.length > 0 &&
        ["strength", "gap", "unknown"].includes(x.assessment),
    );
  const coverage = (expected.length - missing.length) / expected.length;
  const falseCompletion =
    parsed?.complete === true &&
    (missing.length > 0 ||
      unexpected.length > 0 ||
      identityErrors > 0 ||
      duplicates > 0 ||
      !structureValid);
  return {
    structureValid,
    coverage,
    missing,
    unexpected,
    duplicates,
    identityErrors,
    unknownsPreserved,
    falseCompletion,
    pass:
      parsed?.complete === true &&
      structureValid &&
      coverage === 1 &&
      unexpected.length === 0 &&
      duplicates === 0 &&
      identityErrors === 0 &&
      unknownsPreserved,
    semanticSupport: "requires human review",
  };
}
