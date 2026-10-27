/** Release a response body the caller will not read. Never throws. */
export async function discardBody(response: Response) {
  await response.body?.cancel().catch(() => {});
}
/** Read at most `max` bytes of a response body. The limit applies to the decoded
 * stream (`content-length` is the compressed size), and the body is cancelled on
 * every early exit, so its connection is released instead of held until garbage
 * collection. A response without a body reads as empty. */
export async function readBody(
  response: Response,
  max: number,
  tooLarge: () => Error = () => new Error("Response too large"),
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > max) {
    await discardBody(response);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}
