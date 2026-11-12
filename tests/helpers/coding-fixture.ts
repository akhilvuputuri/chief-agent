import { reportDocument } from "@chief-agent/pi-runtime/report";
import { execFileSync } from "node:child_process";
import {
  runPiWorker,
  NativePiWorkerClient,
  piReviewInstructions,
} from "../../src/coding/pi-worker.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAfter, migratedPGlite } from "./pglite.js";
import { ensureUser, type Database } from "../../src/db.js";
import { requirementScope } from "../../src/coding/requirements.js";
import { CodingController } from "../../src/coding/controller.js";
import { selectCodingBackend } from "../../src/coding/backend.js";
import { squadScope } from "../../src/coding/squad-state.js";
import { ModelError, OpenRouter } from "../../src/model.js";
import { formatTelegram } from "../../src/telegram-format.js";
import { codingSettings, outcome } from "../../src/coding/schema.js";
import { codingApi } from "../../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
  canonicalJson,
} from "../../src/coding/github.js";
import { SandboxAcknowledgementPending } from "../../src/coding/provider.js";
import { Workspace } from "../../src/coding/workspace.js";
import { codingLoop } from "../../src/coding/loop.js";
import {
  runWorker,
  WorkerClient,
  WorkerRequestError,
} from "../../src/coding/worker.js";
import { runtimeContext } from "../../src/runtime.js";
import type { SandboxProvider } from "../../src/coding/provider.js";
import { server } from "../../src/server.js";
import { recoverRuntime } from "../../src/execution.js";
import { Assistant } from "../../src/agent.js";
import { CustomAgent } from "../../src/custom-agent.js";
import { JobTools } from "../../src/tools.js";
import Anthropic from "@anthropic-ai/sdk";
import type { CodingAnthropic } from "../../src/coding/pi-messages.js";
import {
  messagesResponse,
  type FakeBlock,
} from "../../coding_runtime_pi/tests/anthropic-sse.js";

/**
 * Pi catalogue models the fixture's Anthropic route hands out, one per distinct job model, so a
 * scripted reply can still tell the roles apart.
 */
const FIXTURE_NATIVE = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

/**
 * A flat view of a Pi Messages request for workflow tests whose subject is not the protocol:
 * one system text, then user, assistant (text and tool calls) and tool-result entries.
 */
export function scriptView(body: any) {
  const text = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
        : "";
  const messages: any[] = [{ role: "system", content: text(body.system) }];
  for (const m of body.messages ?? []) {
    if (m.role === "system") {
      if (text(m.content))
        messages.push({ role: "system", content: text(m.content) });
    } else if (m.role === "assistant") {
      const calls = (m.content ?? []).filter((b: any) => b.type === "tool_use");
      messages.push({
        role: "assistant",
        content: text(m.content) || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((b: any) => ({
                id: b.id,
                type: "function",
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              })),
            }
          : {}),
      });
    } else {
      const results = Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === "tool_result")
        : [];
      if (!results.length)
        messages.push({ role: "user", content: text(m.content) });
      for (const r of results)
        messages.push({
          role: "tool",
          tool_call_id: r.tool_use_id,
          content: text(r.content),
        });
    }
  }
  return {
    messages,
    tools: (body.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    maxOutputTokens: body.max_tokens,
  };
}

/** A scripted { message: { content, tool_calls } } reply as an Anthropic stream. */
export function scriptedResponse(reply: any) {
  const message = reply?.message ?? {};
  const content: FakeBlock[] = [];
  if (typeof message.content === "string" && message.content)
    content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = { unparsable: call.function.arguments };
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    });
  }
  return messagesResponse({ content });
}
export const settings = codingSettings.parse({
  repository: "akhilvuputuri/chief-agent",
  branch: "main",
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  model: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  effort: "high",
  limits: { ms: 900000, models: 40, tools: 100 },
});
export const base = "a".repeat(40);
export const candidate = () => {
  const c = {
    plan: "",
    patch: "fixture diff",
    summary: "Fixture changed",
    files: [
      { path: "src/fixture.ts", content: "export const fixture = true;\n" },
    ],
  };
  return outcome.parse({
    kind: "candidate",
    summary: "Fixture complete",
    checkpoint: c,
    checks: ["check", "build", "format:check"].map((s) => ({
      command: `kite run ${s}`,
      exitCode: 0,
      output: "passed",
    })),
    review: {
      verdict: "APPROVE",
      findings: "Fixture reviewed",
      model: settings.reviewerModel,
      patchHash: artifactHash(c),
    },
  });
};
export async function fixture(
  t: TestContext,
  options: {
    /** Replaces the in-memory sandbox, e.g. with a real box sandbox on this database. */
    provider?: (db: Database) => SandboxProvider;
    settings?: typeof settings;
    /** Replaces the fixture's Anthropic route (every fixture model maps to claude-opus-5-5). */
    anthropic?: CodingAnthropic;
  } = {},
) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','synthetic coding request')",
    [run],
  );
  let now = new Date();
  let permitted = true;
  let creates = 0,
    publishes = 0,
    modelCalls = 0,
    uncertainCreate = false,
    uncertainPublish = false,
    failModel = false;
  let stallModel = false;
  let startupGrace = 0;
  const sandboxes = new Map<
    string,
    { id: string; state: "running" | "terminal" }
  >();
  const sandboxRequests: { timeoutMinutes: number }[] = [];
  const provider = {
    create: async (r: any) => {
      creates++;
      sandboxRequests.push({ timeoutMinutes: r.timeoutMinutes });
      const id = `fixture:${r.attemptId}`;
      sandboxes.set(r.attemptId, { id, state: "running" });
      if (uncertainCreate) throw new Error("private provider error");
      return id;
    },
    find: async (attempt: string, _timeoutMinutes?: number) =>
      sandboxes.get(attempt)?.id,
    inspect: async (id: string) => {
      const s = [...sandboxes.values()].find((v) => v.id === id);
      if (!s) throw new Error("missing");
      return s.state;
    },
    terminate: async (id: string) => {
      const s = [...sandboxes.values()].find((v) => v.id === id)!;
      s.state = "terminal";
    },
    startupGraceMs: () => startupGrace,
  };
  let failModelError = new Error("private model error");
  let published = false;
  let modelReply = "fixture reply";
  let generationReply: ((model: string, input: any) => any) | undefined;
  const messagesRequests: {
    body: Record<string, unknown>;
    wire: { betas: string[]; version?: string };
    signal: AbortSignal;
  }[] = [];
  /** One scripted model reply, shared by the legacy route and the Pi Messages route. */
  const respond = async (selectedModel: string, input: any) => {
    modelCalls++;
    if (stallModel) {
      if (input.signal.aborted) throw input.signal.reason;
      await new Promise((_resolve, reject) =>
        input.signal.addEventListener(
          "abort",
          () => reject(input.signal.reason),
          { once: true },
        ),
      );
    }
    if (failModel) throw failModelError;
    return generationReply
      ? generationReply(selectedModel, input)
      : { message: { role: "assistant", content: modelReply } };
  };
  const natives = new Map<string, string>();
  const nativeFor = (model: string) => {
    if (!natives.has(model))
      natives.set(model, FIXTURE_NATIVE[natives.size % FIXTURE_NATIVE.length]!);
    return natives.get(model)!;
  };
  let messagesReply: CodingAnthropic["send"] = async (body, _wire, signal) => {
    const selected = [...natives].find(([, id]) => id === body.model)?.[0];
    let reply: unknown;
    try {
      reply = await respond(selected ?? String(body.model), {
        ...scriptView(body),
        signal,
      });
    } catch (error) {
      // A scripted provider failure reaches Pi as Anthropic's own error reply: with its HTTP
      // status when the script names one, otherwise as a request the provider refused, which
      // Pi does not retry.
      if (signal.aborted) throw error;
      const status = (error as ModelError)?.diagnostics?.httpStatus;
      throw Anthropic.APIError.generate(
        typeof status === "number" ? status : 400,
        {
          type: "error",
          error: {
            type:
              typeof status === "number" && status >= 500
                ? "api_error"
                : "invalid_request_error",
            message: "Synthetic provider failure",
          },
        },
        undefined,
        new Headers(),
      );
    }
    return scriptedResponse(reply);
  };
  const anthropic: CodingAnthropic = options.anthropic ?? {
    route: (model) =>
      model === "unrouted/model"
        ? undefined
        : {
            nativeModel: nativeFor(model),
            prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
          },
    send: async (body, wire, signal) => {
      messagesRequests.push({ body, wire, signal });
      return messagesReply(body, wire, signal);
    },
  };
  const publisher = {
    resolve: async () => base,
    publish: async () => {
      if (!published) {
        publishes++;
        published = true;
        if (uncertainPublish) throw new Error("PR acknowledgement lost");
      }
      return {
        url: "https://github.com/example/repo/pull/1",
        head: "b".repeat(40),
      };
    },
  };
  const c = new CodingController(
    db,
    options.settings ?? settings,
    options.provider?.(db) ?? provider,
    publisher,
    "c".repeat(64),
    "https://coding.example.com",
    (u) => u === "a" && permitted,
    (selectedModel) => ({
      generate: (input) => respond(selectedModel, input),
    }),
    () => now,
    undefined,
    undefined,
    false,
    undefined,
    anthropic,
  );
  // coding_start leaves a job waiting for the owner's Start (journal 191). Most controller
  // tests need a started job, so the fixture records the owner's Start directly; pass
  // `waiting` to keep the job at its Start card.
  const start = async (key = "request", waiting = false) => {
    const result = (await c.call("a", run, {
      operation: "coding_start",
      requestKey: key,
      objective: "Fix a synthetic bug",
      context: "Synthetic evidence",
    })) as any;
    if (!waiting && result.state === "plan_ready") {
      await db.query(
        "UPDATE coding_jobs SET mode='implement',state='queued',stage='queued',summary='Started by the owner; implementation queued' WHERE id=$1",
        [result.id],
      );
      const job = (
        await db.query("SELECT * FROM coding_jobs WHERE id=$1", [result.id])
      ).rows[0];
      // The Start card becomes the owner's recorded decision.
      await db.query(
        "UPDATE coding_events SET event_key='fixture-approved',payload=$2::jsonb,delivery='suppressed' WHERE job_id=$1 AND payload ? 'requirements'",
        [
          job.id,
          JSON.stringify({
            decision: "approved",
            approvedScope: requirementScope(job),
          }),
        ],
      );
    }
    return c.status("a", result.id);
  };
  const row = async (id: string) =>
    (await db.query("SELECT * FROM coding_jobs WHERE id=$1", [id])).rows[0];
  return {
    startupGrace: (ms: number) => {
      startupGrace = ms;
    },
    db,
    c,
    run,
    start,
    row,
    provider,
    publisher,
    creates: () => creates,
    sandboxRequests: () => sandboxRequests,
    publishes: () => publishes,
    modelCalls: () => modelCalls,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    revoke: () => {
      permitted = false;
    },
    restoreOwner: () => {
      permitted = true;
    },
    uncertainCreate: () => {
      uncertainCreate = true;
    },
    uncertainPublish: () => {
      uncertainPublish = true;
    },
    failModel: (error = new Error("private model error")) => {
      failModel = true;
      failModelError = error;
    },
    stallModel: () => {
      stallModel = true;
    },
    setGeneration: (reply: (model: string, input: any) => any) => {
      generationReply = reply;
    },
    setReply: (text: string) => {
      modelReply = text;
    },
    /** Requests the controller sent to the fixture's Anthropic route. */
    messagesRequests: () => messagesRequests,
    setMessages: (reply: CodingAnthropic["send"]) => {
      messagesReply = reply;
    },
  };
}
/**
 * coding_start, then the delivered Start card (journal 191): nothing is provisioned and no
 * model runs before the owner's Start.
 */
export async function startCard(
  f: Awaited<ReturnType<typeof fixture>>,
  key = "real-start",
  objective = "Build the requested feature",
) {
  const job: any = await f.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: key,
    objective,
    context: "Synthetic scope",
  });
  assert.equal(job.state, "plan_ready");
  assert.equal(job.stage, "awaiting_start");
  await f.c.tick();
  await f.c.tick();
  assert.equal(f.creates(), 0);
  assert.equal(f.modelCalls(), 0);
  let messageId = 100;
  let approvalId = "";
  let card = "";
  // Earlier jobs' notices may be delivered first.
  for (let i = 0; i < 5 && !approvalId; i++)
    await f.c.deliver(async (_user, target, text, id, plain) => {
      assert.deepEqual(target, { kind: "topic", topic: "coding" });
      if (id) {
        approvalId = id.id;
        card = plain ? `${text}\n\n${plain}` : text;
      }
      return { message_id: ++messageId };
    });
  assert(approvalId, "Start card was not delivered");
  return { jobId: job.id as string, approvalId, messageId, card };
}

/** An Anthropic route for controllers a test builds itself; it never sends a request. */
export const unusedAnthropic: CodingAnthropic = {
  route: () => ({
    nativeModel: "claude-opus-5-5",
    prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  }),
  send: async () => {
    throw new Error("This test makes no model call");
  },
};
