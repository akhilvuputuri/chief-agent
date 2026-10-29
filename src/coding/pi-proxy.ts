import { z } from "zod";
import type { CodingController, CodingJob } from "./controller.js";
import { ModelError } from "../model.js";

const text = z.union([
  z.string().max(1_000_000),
  z
    .array(z.object({ type: z.literal("text"), text: z.string() }).strict())
    .transform((parts) => parts.map((p) => p.text).join(""))
    .pipe(z.string().max(1_000_000)),
  z.null(),
]);
const nativeMessage = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: text,
    tool_call_id: z.string().max(200).optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().max(200),
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().max(100),
                arguments: z.string().max(1_000_000),
              })
              .strict(),
            index: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    reasoning_details: z.array(z.record(z.unknown())).optional(),
    // Pi replays this DeepSeek compatibility field even when structured reasoning is present.
    reasoning_content: z.string().max(1_000_000).optional(),
  })
  .strict();
export const piCompletionRequest = z
  .object({
    runtime_call_id: z.string().uuid(),
    model: z.string().max(120),
    // Small tool results can legitimately outnumber 120 messages before token
    // compaction. The byte envelope and durable job allocations remain binding.
    messages: z.array(nativeMessage).max(2048),
    tools: z
      .array(
        z
          .object({
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().max(100),
                description: z.string().max(2000).optional(),
                parameters: z.record(z.unknown()),
                strict: z.boolean().optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    stream: z.boolean().optional(),
    max_tokens: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    max_completion_tokens: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    runtime_purpose: z.enum(["agent", "compaction"]).optional(),
  })
  .passthrough();

/** Native protocol facade. Policy, credential access and call journal stay on Chief. */
export async function piCompletion(
  controller: CodingController,
  job: CodingJob,
  role: "coder" | "reviewer",
  raw: unknown,
  retryParent?: unknown,
) {
  if (job.settings.runtime !== "pi")
    throw new Error("Native Pi endpoint requires a Pi job");
  if (Buffer.byteLength(JSON.stringify(raw)) > 4_000_000)
    throw new ModelError("Model input exceeds gateway limit", false, {
      failureCode: "context_limit",
    });
  const input = piCompletionRequest.parse(raw);
  const retryOf =
    retryParent === undefined
      ? undefined
      : z.string().uuid().parse(retryParent);
  if (
    input.max_tokens !== undefined &&
    input.max_completion_tokens !== undefined &&
    input.max_tokens !== input.max_completion_tokens
  )
    throw new Error("Conflicting native output limits");
  const requestedOutput = input.max_tokens ?? input.max_completion_tokens;
  if (role === "reviewer" && job.mode !== "implement")
    throw new Error("Reviewer model requires approved implementation");
  const effectiveRole =
    role === "coder" && job.mode === "plan" ? "leader" : role;
  const selected =
    effectiveRole === "reviewer"
      ? job.settings.reviewerModel
      : effectiveRole === "leader"
        ? (job.settings.leaderModel ?? job.settings.model)
        : job.settings.model;
  if (input.model !== selected)
    throw new Error("Model is not the job's pinned role selection");
  const result = await controller.generate(job, {
    callId: input.runtime_call_id,
    role: effectiveRole,
    ...(retryOf ? { retryOf } : {}),
    ...(requestedOutput !== undefined
      ? { maxOutputTokens: requestedOutput }
      : {}),
    ...(input.runtime_purpose ? { purpose: input.runtime_purpose } : {}),
    messages: input.messages,
    tools: (input.tools ?? []).map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: t.function.parameters,
    })),
  });
  const reason = result.message.tool_calls?.length ? "tool_calls" : "stop";
  const body = {
    id: input.runtime_call_id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: selected,
    choices: [
      {
        index: 0,
        message: { ...result.message, role: "assistant" },
        finish_reason: reason,
      },
    ],
    usage: result.usage,
  };
  if (!input.stream) return { stream: false, body };
  // Chief currently assembles provider generations. This is framed compatibility,
  // not a claim of live token streaming from the underlying provider.
  const chunk = {
    ...body,
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { ...result.message, role: "assistant" },
        finish_reason: null,
      },
    ],
  };
  const terminal = {
    ...body,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
  return {
    stream: true,
    body: `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
  };
}
