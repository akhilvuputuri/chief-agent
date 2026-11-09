import { Agent, fetch as undiciFetch } from "undici";

/**
 * Node's built-in fetch gives up when response headers take more than 300 seconds, but the
 * host answers a model call only when the whole generation is done, which can take longer
 * with a large output allowance (journal 156). Node's bundled undici cannot use a newer
 * dispatcher, so these requests go through undici's own fetch with a matching timeout.
 */
export function patientFetch(timeoutMs: number): typeof globalThis.fetch {
  const dispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Callers pass Node's Request, which undici's own fetch does not accept.
    const request = new Request(input, init);
    return undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      redirect: request.redirect,
      dispatcher,
    });
  }) as unknown as typeof globalThis.fetch;
}
