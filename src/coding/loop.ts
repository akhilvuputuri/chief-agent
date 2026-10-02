import { z } from "zod";
import type { ModelAdapter, Message, ToolDefinition } from "../model.js";
import type { Workspace } from "./workspace.js";

const tool = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("file_read"),
      path: z.string(),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      operation: z.literal("file_write"),
      path: z.string(),
      content: z.string().max(128000),
    })
    .strict(),
  z.object({ operation: z.literal("file_delete"), path: z.string() }).strict(),
  z
    .object({
      operation: z.literal("plan_read"),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      operation: z.literal("command"),
      command: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("report"),
      kind: z.enum([
        "plan_ready",
        "awaiting_input",
        "candidate",
        "APPROVE",
        "REQUEST_CHANGES",
      ]),
      summary: z.string().max(4000),
      plan: z.string().max(32000).default(""),
      question: z.string().max(2000).default(""),
    })
    .strict(),
]);
export type LoopReport = Extract<z.infer<typeof tool>, { operation: "report" }>;
const defs: ToolDefinition[] = [
  {
    name: "plan_read",
    description:
      "Read the current saved implementation plan in bounded pages. Follow nextOffset until null; a plan preview is incomplete.",
    parameters: {
      type: "object",
      properties: { offset: { type: "integer", minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: "file_read",
    description: "Read a repository file in bounded pages.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "file_write",
    description: "Write a complete UTF-8 repository file. Read before editing.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "file_delete",
    description: "Delete a repository file as part of the requested change.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "command",
    description:
      "Execute a shell command within the disposable checkout. Prefer rg to search. Output is bounded; use files for large outputs.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "report",
    description:
      "Return a plan, question, coding candidate, or independent review verdict.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [
            "plan_ready",
            "awaiting_input",
            "candidate",
            "APPROVE",
            "REQUEST_CHANGES",
          ],
        },
        summary: { type: "string" },
        plan: { type: "string" },
        question: { type: "string" },
      },
      required: ["kind", "summary"],
      additionalProperties: false,
    },
  },
];
export type LoopBudget = { models: number; tools: number };
export async function codingLoop(input: {
  model: ModelAdapter;
  workspace: Workspace;
  messages: Message[];
  mode: "plan" | "implement" | "review";
  budget: LoopBudget;
  signal: AbortSignal;
  checkpoint: () => Promise<void>;
  plan?: () => string;
}): Promise<LoopReport> {
  const messages = input.messages;
  const tools = defs.filter(
    (d) =>
      input.mode === "implement" ||
      ["file_read", "plan_read", "report", "command"].includes(d.name),
  );
  if (!input.plan)
    tools.splice(
      tools.findIndex((t) => t.name === "plan_read"),
      1,
    );
  while (
    input.budget.models > 0 &&
    input.budget.tools > 0 &&
    !input.signal.aborted
  ) {
    for (const previous of messages)
      for (const call of previous.tool_calls ?? [])
        if (call.function.arguments.length > 16000)
          call.function.arguments = JSON.stringify({
            archived: true,
            note: "Large arguments are retained in the private model journal; read repository files for their current contents.",
          });
    // Preserve the assignment and recent observations. Old results remain in private worker artifacts.
    while (
      (Buffer.byteLength(
        JSON.stringify({
          callId: "00000000-0000-4000-8000-000000000000",
          role: "reviewer",
          messages,
          tools,
        }),
      ) > 150000 ||
        messages.length > 110) &&
      messages.length > 4
    ) {
      let end = 2;
      if (messages[end]?.role === "assistant" && messages[end]?.tool_calls) {
        end++;
        while (messages[end]?.role === "tool") end++;
      } else end++;
      if (end >= messages.length) break;
      messages.splice(2, end - 2);
    }
    input.budget.models--;
    const generation = await input.model.generate({
      messages,
      tools,
      reasoning: "high",
      signal: input.signal,
    });
    const m = generation.message;
    delete m.reasoning_details;
    messages.push(m);
    if (!m.tool_calls?.length) {
      messages.push({
        role: "user",
        content:
          "Use report to return the result, or continue using the available tools.",
      });
      continue;
    }
    for (const call of m.tool_calls) {
      if (input.signal.aborted || input.budget.tools-- <= 0)
        throw new Error("Coding allocation exhausted");
      let result: unknown;
      // JSON escaping and UTF-8 can expand a character up to six bytes.
      const observationChars = Math.max(
        500,
        Math.floor(36000 / (6 * m.tool_calls.length)),
      );
      try {
        const a = tool.parse({
          ...JSON.parse(call.function.arguments),
          operation: call.function.name,
        });
        if (a.operation === "report") {
          if (
            input.mode === "plan" &&
            !["plan_ready", "awaiting_input"].includes(a.kind)
          )
            throw new Error("Plan mode requires a plan or question");
          if (
            input.mode === "review" &&
            !["APPROVE", "REQUEST_CHANGES"].includes(a.kind)
          )
            throw new Error("Review requires an explicit verdict");
          if (
            input.mode === "implement" &&
            !["candidate", "awaiting_input"].includes(a.kind)
          )
            throw new Error("Implementation requires a candidate or question");
          // Complete every tool-call slot before continuing after host verification or review.
          for (const pending of m.tool_calls.slice(m.tool_calls.indexOf(call)))
            messages.push({
              role: "tool",
              tool_call_id: pending.id,
              content: JSON.stringify({
                reported: pending.id === call.id,
                skipped: pending.id !== call.id,
              }),
            });
          return a;
        }
        if (a.operation === "plan_read") {
          if (!input.plan) throw new Error("Plan reader unavailable");
          const text = input.plan();
          result = {
            text: text.slice(a.offset, a.offset + observationChars),
            nextOffset:
              a.offset + observationChars < text.length
                ? a.offset + observationChars
                : null,
          };
        } else if (a.operation === "file_read")
          result = await input.workspace.read(
            a.path,
            a.offset,
            observationChars,
          );
        else if (a.operation === "file_write") {
          if (input.mode !== "implement")
            throw new Error("Read-only agent cannot write");
          result = await input.workspace.write(a.path, a.content);
          await input.checkpoint();
        } else if (a.operation === "file_delete") {
          if (input.mode !== "implement")
            throw new Error("Read-only agent cannot delete");
          result = await input.workspace.remove(a.path);
          await input.checkpoint();
        } else {
          // Planning and review command forms are host-selected read operations only.
          if (input.mode !== "implement") {
            const match =
              /^(git (status --short|diff --cached --no-ext-diff|ls-files)|rg --files)$/.exec(
                a.command,
              );
            if (!match)
              throw new Error(
                "Read-only agents may use git status --short, git diff --cached --no-ext-diff, git ls-files or rg --files; use file_read for contents",
              );
            const [cmd, ...args] = a.command.split(" ");
            result = await input.workspace.command(
              cmd!,
              args,
              false,
              120000,
              observationChars,
            );
          } else {
            result = await input.workspace.command(
              a.command,
              [],
              true,
              120000,
              observationChars,
            );
            await input.checkpoint();
          }
        }
      } catch {
        result = {
          error:
            "Tool rejected or failed; inspect files/status and adjust the call. Paths, modes and allocations are enforced by the host.",
        };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Error("Coding allocation exhausted");
}
