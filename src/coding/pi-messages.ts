import Anthropic from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AnthropicPrices } from "../anthropic.js";
import type { CodingFailureCode } from "./model-failure.js";

/**
 * How a Pi coding job reaches Claude: the worker runs Pi's own Anthropic Messages client against
 * the host, and the host sends each request on with its key and relays Anthropic's stream
 * back unchanged (journal 181).
 */
export type CodingAnthropic = {
  /** The direct route for a job's model, or undefined when the model has none. */
  route(
    model: string,
  ): { nativeModel: string; prices: AnthropicPrices } | undefined;
  /** Sends the request with the beta features and API version Pi's client named. */
  send(
    body: Record<string, unknown>,
    wire: { betas: string[]; version?: string },
    signal: AbortSignal,
  ): Promise<Response>;
};

/** What the worker gets back: Anthropic's own stream, or an error in Anthropic's shape. */
export type MessagesReply = {
  status: number;
  headers: Record<string, string>;
  body: string | ReadableStream<Uint8Array>;
};

/**
 * An error in the shape Pi's Anthropic client reads. A host refusal (400) is final; a failed
 * connection to Anthropic (502) is left to Pi's own retry policy.
 */
export function refusal(message: string, status = 400): MessagesReply {
  return {
    status,
    headers: {
      "content-type": "application/json",
      ...(status === 400 ? { "x-should-retry": "false" } : {}),
    },
    body: JSON.stringify({
      type: "error",
      error: {
        type: status === 400 ? "invalid_request_error" : "api_error",
        message,
      },
    }),
  };
}

/** Anthropic's own error reply, with the headers Pi's retry policy reads. */
export function relayedError(error: InstanceType<typeof Anthropic.APIError>) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const name of [
    "retry-after",
    "retry-after-ms",
    "x-should-retry",
    "request-id",
  ]) {
    const value = error.headers?.get(name);
    if (value) headers[name] = value;
  }
  return {
    status: error.status!,
    headers,
    body: JSON.stringify(
      error.error ?? {
        type: "error",
        error: { type: "api_error", message: "Model request failed" },
      },
    ),
  } satisfies MessagesReply;
}

/**
 * The only changes the host makes to a request: the job decides the effort and caps the output,
 * and the box may not pick another model, fallback models or a priced speed. Everything else
 * (messages, system prompt, tools, thinking, cache breakpoints) goes to Anthropic as Pi built it.
 */
export function messagesRequest(
  raw: unknown,
  pinned: { model: string; effort: string; maxTokens: number },
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Array.isArray((raw as { messages?: unknown }).messages)
  )
    throw new Error("Invalid Messages request");
  const body = raw as Record<string, unknown> & { messages: unknown[] };
  if (body.model !== pinned.model)
    throw new Error("Model is not the job's pinned role selection");
  if ("fallbacks" in body || "speed" in body)
    throw new Error("Model request names fallback models or a speed");
  for (const message of body.messages) {
    const config = (message as { role?: unknown; output_config?: unknown })
      ?.output_config;
    if (
      (message as { role?: unknown })?.role === "system" &&
      config &&
      typeof config === "object" &&
      "effort" in config &&
      (config as { effort: unknown }).effort !== pinned.effort
    )
      throw new Error("Model effort differs from the job's effort");
  }
  const requested = body.max_tokens;
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1
  )
    throw new Error("Invalid Messages request");
  const output =
    body.output_config && typeof body.output_config === "object"
      ? body.output_config
      : {};
  return {
    ...body,
    max_tokens: Math.min(requested, pinned.maxTokens),
    output_config: { ...output, effort: pinned.effort },
  };
}

export function betaList(header: string | string[] | undefined) {
  return [
    ...new Set(
      (Array.isArray(header) ? header.join(",") : (header ?? ""))
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ),
  ];
}

/** The failure code a refused or failed upstream call records, as the earlier route did. */
export function upstreamFailureCode(
  status: number | undefined,
  type: string | null | undefined,
): CodingFailureCode {
  if (status === 429 || type === "rate_limit_error")
    return "model_rate_limited";
  if (
    (status !== undefined && status >= 500) ||
    type === "overloaded_error" ||
    type === "api_error"
  )
    return "model_transient_failure";
  return "model_provider_failed";
}

/**
 * Reads the host's copy of a relayed stream into the message Anthropic returned, using the SDK's
 * own accumulator. `complete` is false when the stream ended before message_stop.
 */
export async function assembleStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: BetaRawMessageStreamEvent) => void,
): Promise<{
  message?: BetaMessage;
  complete: boolean;
  error?: unknown;
}> {
  const sse = Stream.fromSSEResponse<BetaRawMessageStreamEvent>(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    new AbortController(),
  );
  const stream = BetaMessageStream.fromReadableStream(sse.toReadableStream());
  let stopped = false;
  stream.on("streamEvent", (event) => {
    if (event.type === "message_stop") stopped = true;
    onEvent(event as BetaRawMessageStreamEvent);
  });
  // The accumulator reports failures through finalMessage as well; never let them go unhandled.
  stream.on("error", () => {});
  try {
    const message = await stream.finalMessage();
    return { message, complete: stopped };
  } catch (error) {
    return { message: stream.currentMessage, complete: false, error };
  }
}
