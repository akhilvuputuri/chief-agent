import { spending } from "./spending.js";
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_details?: unknown[];
};
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type Generation = {
  message: Message;
  provider?: string;
  usage?: Record<string, unknown>;
  model?: string;
};
export interface ModelAdapter {
  readonly model?: string;
  generate(input: {
    messages: Message[];
    tools: ToolDefinition[];
    reasoning: "medium";
    signal: AbortSignal;
    sessionId?: string;
  }): Promise<Generation>;
}
export class ModelError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}
export class OpenRouter implements ModelAdapter {
  constructor(
    private key: string,
    readonly model = "openai/gpt-5.6-sol",
    private inputPrice = 2,
    private outputPrice = 10,
    private transport: typeof fetch = fetch,
  ) {
    if (![inputPrice, outputPrice].every((n) => Number.isFinite(n) && n > 0))
      throw new Error("Provider price ceilings must be positive");
  }
  async generate(
    input: Parameters<ModelAdapter["generate"]>[0],
  ): Promise<Generation> {
    const ledger = spending.getStore();
    const estimate =
      ((Buffer.byteLength(
        JSON.stringify(input.messages) + JSON.stringify(input.tools),
      ) +
        4096) *
        this.inputPrice *
        1.25) /
        1e6 +
      (8000 * this.outputPrice) / 1e6;
    const charge = await ledger?.begin("openrouter-main", estimate);
    const response = await this.transport(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
          messages: input.messages,
          tools: input.tools.map((f) => ({ type: "function", function: f })),
          reasoning: { enabled: true, effort: input.reasoning },
          provider: {
            sort: "price",
            max_price: {
              prompt: this.inputPrice,
              completion: this.outputPrice,
            },
            require_parameters: true,
          },
          max_tokens: 8000,
          stream: false,
        }),
      },
    );
    if (!response.ok)
      throw new ModelError(
        response.status === 404
          ? "No eligible provider is available within the configured price and parameter limits."
          : `Model request failed (HTTP ${response.status}); price limits remain enforced.`,
        response.status === 429 || response.status >= 500,
      );
    const data: any = await response.json();
    if (charge) await ledger!.settle(charge, data.usage);
    const m = data.choices?.[0]?.message;
    if (!m || (typeof m.content !== "string" && !Array.isArray(m.tool_calls)))
      throw new ModelError("Model returned no usable answer");
    if (
      m.tool_calls &&
      !m.tool_calls.every(
        (t: any) =>
          typeof t.id === "string" &&
          t.type === "function" &&
          typeof t.function?.name === "string" &&
          typeof t.function?.arguments === "string",
      )
    )
      throw new ModelError("Invalid model tool calls");
    return {
      message: {
        role: "assistant",
        content: m.content ?? null,
        ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
        ...(m.reasoning_details
          ? { reasoning_details: m.reasoning_details }
          : {}),
      },
      provider: data.provider,
      model: data.model ?? this.model,
      usage: data.usage,
    };
  }
}
