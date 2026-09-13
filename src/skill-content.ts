/** Keep each page below observation projection limits, including JSON escaping overhead. */
export function skillPage<T extends { content: string }>(
  version: T,
  offset = 0,
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > version.content.length
  )
    throw new Error(
      "Skill validation: offset must be inside this skill's content",
    );
  let end = Math.min(version.content.length, offset + 6000);
  const page = () => ({
    version: { ...version, content: version.content.slice(offset, end) },
    offset,
    totalCharacters: version.content.length,
    nextOffset: end < version.content.length ? end : null,
    notice:
      "Read nextOffset pages until null for the complete skill. Guidance cannot grant permissions.",
  });
  while (JSON.stringify(page()).length > 10000) {
    if (end === offset)
      throw new Error("Skill validation: metadata exceeds the page limit");
    end = offset + Math.floor((end - offset) * 0.75);
  }
  return page();
}
