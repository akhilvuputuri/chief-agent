// A deterministic Anthropic Messages stream for tests: no paid inference.
export type FakeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type FakeTurn = {
  id?: string;
  model?: string;
  content: FakeBlock[];
  stopReason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

const event = (type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;

/** The message_start event alone, for streams a test leaves open. */
export function messageStart(turn: Omit<FakeTurn, "content">) {
  return event("message_start", {
    message: {
      id: turn.id ?? "msg_fixture",
      type: "message",
      role: "assistant",
      model: turn.model ?? "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: turn.usage?.input_tokens ?? 100,
        output_tokens: 1,
        cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens:
          turn.usage?.cache_creation_input_tokens ?? 0,
      },
    },
  });
}

/** Server-sent events exactly as the Messages API streams one response. */
export function messagesStream(turn: FakeTurn) {
  let out = messageStart(turn);
  turn.content.forEach((block, index) => {
    if (block.type === "text") {
      out += event("content_block_start", {
        index,
        content_block: { type: "text", text: "" },
      });
      out += event("content_block_delta", {
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else if (block.type === "thinking") {
      out += event("content_block_start", {
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      if (block.thinking)
        out += event("content_block_delta", {
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        });
      out += event("content_block_delta", {
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    } else if (block.type === "redacted_thinking") {
      out += event("content_block_start", {
        index,
        content_block: { type: "redacted_thinking", data: block.data },
      });
    } else {
      out += event("content_block_start", {
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      out += event("content_block_delta", {
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    }
    out += event("content_block_stop", { index });
  });
  out += event("message_delta", {
    delta: {
      stop_reason:
        turn.stopReason ??
        (turn.content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : "end_turn"),
      stop_sequence: null,
    },
    usage: { output_tokens: turn.usage?.output_tokens ?? 50 },
  });
  out += event("message_stop", {});
  return out;
}

/** A Response carrying the stream, as the Anthropic SDK's raw response would. */
export function messagesResponse(turn: FakeTurn) {
  return new Response(messagesStream(turn), {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_fix" },
  });
}

/** Tool calls for a fixture turn. */
export function toolUse(id: string, name: string, input: unknown): FakeBlock {
  return { type: "tool_use", id, name, input };
}
