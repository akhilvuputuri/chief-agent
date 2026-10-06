/** Only current GitHub thread state can close feedback; historical prose cannot. */
export function activeInlineComments(
  comments: any[],
  resolvedIds: Set<number>,
) {
  return comments.filter((c) => !resolvedIds.has(c.id));
}
