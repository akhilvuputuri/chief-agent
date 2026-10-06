/** A resolved thread is peer/owner state, not a model's assertion that it fixed a finding. */
export function activeInlineComments(
  comments: any[],
  resolvedIds: Set<number>,
) {
  const closedByDevin = new Set<number>();
  for (const reply of comments) {
    if (
      reply.user?.login !== "devin-ai-integration[bot]" ||
      !/^✅\s*\*\*Resolved\*\*:/u.test(reply.body ?? "") ||
      !Number.isSafeInteger(reply.in_reply_to_id)
    )
      continue;
    const root = comments.find((c) => c.id === reply.in_reply_to_id);
    if (root?.user?.login !== "devin-ai-integration[bot]") continue;
    const resolvedAt = Date.parse(reply.created_at ?? reply.updated_at);
    const updatedAt = Date.parse(root.updated_at ?? root.created_at);
    if (
      Number.isFinite(resolvedAt) &&
      Number.isFinite(updatedAt) &&
      resolvedAt >= updatedAt
    )
      closedByDevin.add(root.id);
  }
  return comments.filter(
    (c) =>
      !resolvedIds.has(c.id) &&
      !closedByDevin.has(c.id) &&
      !(
        closedByDevin.has(c.in_reply_to_id) &&
        /^✅\s*\*\*Resolved\*\*:/u.test(c.body ?? "") &&
        c.user?.login === "devin-ai-integration[bot]"
      ),
  );
}
