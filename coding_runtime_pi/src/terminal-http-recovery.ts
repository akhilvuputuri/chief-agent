import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const retryParentHeader = "x-runtime-retry-of";
export const terminalHttpStatuses = [429, 500, 502, 503, 504] as const;
export type TerminalHttpStatus = (typeof terminalHttpStatuses)[number];
export type TerminalHttpReceipt = {
  version: 1;
  kind: "terminal-provider-http";
  callId: string;
  attemptId: string;
  providerStatus: TerminalHttpStatus;
};
export function isTerminalHttpStatus(
  value: unknown,
): value is TerminalHttpStatus {
  return terminalHttpStatuses.some((status) => status === value);
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boundedReceipt(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    return;
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        // Awaiting cancellation of one tee branch can wait for the SDK to read
        // the other branch. Leave the original response available to the SDK.
        void reader.cancel().catch(() => {});
        return;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    signal.throwIfAborted();
    return;
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One additional inference per logical generation; never an agent-loop retry. */
export function terminalHttpRecoveryFetch(options: {
  attemptId: string;
  baseUrl: string;
  requestIdField: string;
  admit: () => Promise<void>;
  fetch: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  if (!uuid.test(options.attemptId))
    throw new Error("Invalid recovery attempt identity");
  const target = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let additionalUsed = false;
  return async (input, init) => {
    const request = new Request(input, init);
    const eligibleRoute =
      request.method === "POST" &&
      request.url === target &&
      !request.headers.has(retryParentHeader);
    const saved = eligibleRoute ? request.clone() : undefined;
    const response = await options.fetch(request);
    if (
      !saved ||
      additionalUsed ||
      response.status !== 409 ||
      (response.url && response.url !== request.url)
    )
      return response;
    let body: Record<string, unknown>;
    try {
      const raw = await saved.text();
      if (Buffer.byteLength(raw) > 180000) return response;
      body = JSON.parse(raw);
      if (!body || Array.isArray(body) || typeof body !== "object")
        return response;
    } catch {
      return response;
    }
    const callId = body[options.requestIdField];
    if (typeof callId !== "string" || !uuid.test(callId)) return response;
    const value = (await boundedReceipt(response, request.signal)) as
      { code?: unknown; recovery?: unknown } | undefined;
    const receipt = value?.recovery as Partial<TerminalHttpReceipt> | undefined;
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(",") !==
        "attemptId,callId,kind,providerStatus,version" ||
      receipt.version !== 1 ||
      receipt.kind !== "terminal-provider-http" ||
      receipt.callId !== callId ||
      receipt.attemptId !== options.attemptId ||
      !isTerminalHttpStatus(receipt.providerStatus) ||
      value?.code !==
        (receipt.providerStatus === 429
          ? "model_rate_limited"
          : "model_transient_failure")
    )
      return response;
    request.signal.throwIfAborted();
    additionalUsed = true;
    await response.body?.cancel();
    await delay(1000, undefined, { signal: request.signal });
    await options.admit();
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.set(retryParentHeader, callId);
    body[options.requestIdField] = randomUUID();
    // No first-attempt data has reached the SDK or tool loop. Preserve every
    // model field, cache hint and output bound; only the request identity changes.
    const next = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
      redirect: request.redirect,
    });
    return options.fetch(next);
  };
}
