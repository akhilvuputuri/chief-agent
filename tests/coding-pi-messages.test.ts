import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingRuntime,
  TaskStore,
  anthropicModel,
  localExecutor,
  reportReminder,
} from "@chief-agent/pi-runtime";
import { AnthropicMessagesGateway, anthropicUsage } from "../src/anthropic.js";
import { GATEWAY_RETRY } from "../src/coding/pi-worker.js";
import { retryDelayMs } from "@earendil-works/pi-ai";
import { server } from "../src/server.js";
import { codingApi } from "../src/coding/api.js";
import { settings, fixture } from "./helpers/coding-fixture.js";
import {
  messageStart,
  messagesResponse,
  messagesStream,
  toolUse,
  type FakeTurn,
} from "../coding_runtime_pi/tests/anthropic-sse.js";

/** A running Pi job, the gateway routes and the worker's capability header. */
async function piJob(t: TestContext) {
  const f = await fixture(t);
  const started = await f.start("pi");
  await f.c.tick();
  let job = await f.row(started.id);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
      effort: "medium",
      maxOutputTokens: 32000,
      reviewerMaxOutputTokens: 16000,
    }),
  ]);
  job = await f.row(job.id);
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const headers = {
    "x-api-key": f.c.token(job.id, job.attempt_id),
    "anthropic-beta":
      "mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01",
    "x-runtime-purpose": "agent",
    "anthropic-version": "2023-06-01",
  };
  const url = (role = "coder") =>
    `/coding/worker/${job.id}/pi/${role}/v1/messages?beta=true`;
  /** Waits until the host has recorded every relayed call. */
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const busy = (
        await f.db.query("SELECT model_busy FROM coding_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0].model_busy;
      if (!busy) return;
      await delay(10);
    }
    throw new Error("Model call was never recorded");
  };
  const calls = async () =>
    (
      await f.db.query(
        "SELECT id,role,state,input,result,result_box FROM coding_model_calls WHERE job_id=$1 ORDER BY created_at,id",
        [job.id],
      )
    ).rows;
  const events = async (kind: string) =>
    (
      await f.db.query(
        "SELECT payload FROM coding_events WHERE job_id=$1 AND payload->>'kind'=$2 ORDER BY id",
        [job.id, kind],
      )
    ).rows.map((r: any) => r.payload);
  return { f, job, app, headers, url, settled, calls, events };
}

/** A request as Pi's Anthropic client builds it. */
const request = (overrides: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5",
  max_tokens: 128000,
  stream: true,
  system: [
    {
      type: "text",
      text: "Pi system prompt",
      cache_control: { type: "ephemeral" },
    },
  ],
  thinking: {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  },
  output_config: { effort: "high" },
  tools: [
    {
      name: "read",
      description: "Read a file",
      eager_input_streaming: true,
      input_schema: { type: "object", properties: {}, required: [] },
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [
    { role: "user", content: "Plan the fix" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "c2lnLTE=" },
        { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } },
      ],
    },
    { role: "system", content: [], output_config: { effort: "medium" } },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "source",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    { role: "system", content: [], output_config: { effort: "medium" } },
  ],
  ...overrides,
});

test("the host relays Pi's request and Anthropic's stream unchanged, deciding only model, effort and output cap", async (t) => {
  const { f, app, headers, url, settled, calls, events } = await piJob(t);
  const turn = {
    id: "msg_relay",
    content: [
      { type: "thinking" as const, thinking: "", signature: "c2lnLTI=" },
      { type: "text" as const, text: "Reading café" },
      toolUse("toolu_2", "read", { path: "b" }),
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 300,
    },
  };
  f.setMessages(async () => messagesResponse(turn));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: url(),
        payload: request(),
        headers: { ...headers, "x-api-key": "forged" },
      })
    ).statusCode,
    401,
  );
  const body = request();
  const response = await app.inject({
    method: "POST",
    url: url(),
    payload: body,
    headers,
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /text\/event-stream/);
  // The worker receives Anthropic's bytes exactly.
  assert.equal(response.body, messagesStream(turn));
  await settled();
  const [sent] = f.messagesRequests();
  assert.equal(sent!.wire.version, "2023-06-01");
  assert.deepEqual(sent!.wire.betas, [
    "mid-conversation-output-config-2026-07-01",
    "thinking-binding-controls-2026-08-01",
  ]);
  // Only the job's output cap and effort replace Pi's values; nothing else changes.
  assert.deepEqual(sent!.body, {
    ...body,
    max_tokens: 32000,
    output_config: { effort: "medium" },
  });
  assert(!JSON.stringify(sent).includes(headers["x-api-key"]));
  const [call] = await calls();
  assert.equal(call.state, "complete");
  assert.equal(call.role, "coder");
  assert.equal(call.input.purpose, "agent");
  assert.equal(call.input.requestedModel, settings.model);
  assert.deepEqual(call.input.request.messages, body.messages);
  // The recorded result is the message Anthropic returned.
  assert.equal(call.result.id, "msg_relay");
  assert.deepEqual(call.result.content, turn.content);
  assert.equal(call.result.stop_reason, "tool_use");
  const [usage] = await events("model_usage");
  assert.equal(usage.role, "coder");
  assert.equal(usage.purpose, "agent");
  assert.equal(usage.provider, "Anthropic");
  assert.equal(usage.model, settings.model);
  assert.equal(usage.usage.prompt_tokens, 6300);
  assert.equal(usage.usage.completion_tokens, 200);
  assert.equal(usage.usage.prompt_tokens_details.cached_tokens, 5000);
  assert.equal(usage.usage.prompt_tokens_details.cache_write_tokens, 300);
  assert.equal(
    usage.usage.cost,
    (1000 * 4 + 5000 * 0.2 + 300 * 5 + 200 * 20) / 1e6,
  );
  assert.equal(usage.incomplete, undefined);
  assert.equal(
    (await f.row((await f.db.query("SELECT id FROM coding_jobs")).rows[0].id))
      .model_busy,
    false,
  );
});

test("the host refuses anything Pi does not send, before any call", async (t) => {
  const { f, app, headers, url, calls, events } = await piJob(t);
  const tool = (extra: Record<string, unknown>) => ({
    tools: [{ name: "x", ...extra }],
  });
  const cases: [Record<string, unknown>, string][] = [
    [{ model: "claude-opus-5" }, "model_not_pinned"],
    [
      {
        messages: [
          { role: "user", content: "x" },
          { role: "system", content: [], output_config: { effort: "max" } },
        ],
      },
      "effort_not_pinned",
    ],
    // Fields Pi never sends; some would become headers that override the host's.
    ...[
      "workspace_id",
      "user_profile_id",
      "betas",
      "mcp_servers",
      "container",
      "service_tier",
      "inference_geo",
      "context_management",
      "speed",
      "fallbacks",
      "temperature",
    ].map(
      (field) =>
        [{ [field]: "x" }, "messages_field_refused"] as [
          Record<string, unknown>,
          string,
        ],
    ),
    [
      { output_config: { effort: "medium", task_budget: {} } },
      "messages_field_refused",
    ],
    [
      {
        messages: [
          { role: "user", content: "x" },
          {
            role: "system",
            content: [],
            output_config: { effort: "medium", format: {} },
          },
        ],
      },
      "messages_field_refused",
    ],
    [{ metadata: { user_id: "u", other: 1 } }, "messages_field_refused"],
    // Server tools run on Anthropic's side; only Pi's own tools may be defined.
    ...[
      "web_search_20260209",
      "web_fetch_20260209",
      "code_execution_20260521",
      "mcp_toolset",
      "computer_toolset_20260801",
      "memory_20250818",
    ].map(
      (type) =>
        [tool({ type }), "server_tool_refused"] as [
          Record<string, unknown>,
          string,
        ],
    ),
    [
      {
        messages: [
          {
            role: "system",
            content: [
              {
                type: "tool_addition",
                tool: {
                  type: "tool_definition",
                  definition: { type: "web_fetch_20260209", name: "web_fetch" },
                },
              },
            ],
          },
        ],
      },
      "server_tool_refused",
    ],
    [{ tool_choice: { type: "any" } }, "tool_choice_refused"],
    [{ tool_choice: { type: "tool", name: "report" } }, "tool_choice_refused"],
    [
      { tool_choice: { type: "auto", disable_parallel_tool_use: true } },
      "tool_choice_refused",
    ],
    // Content the API would fetch or run on the box's behalf.
    ...(
      [
        [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "url", url: "https://example.invalid/x.pdf" },
              },
            ],
          },
          "content_block_refused",
        ],
        [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "url",
                      url: "https://example.invalid/i.png",
                    },
                  },
                ],
              },
            ],
          },
          "content_source_refused",
        ],
        [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "file", file_id: "file_1" } },
            ],
          },
          "content_source_refused",
        ],
        [
          {
            role: "user",
            content: [{ type: "container_upload", file_id: "file_1" }],
          },
          "content_block_refused",
        ],
        [
          {
            role: "assistant",
            content: [
              {
                type: "server_tool_use",
                id: "srvtoolu_1",
                name: "web_fetch",
                input: { url: "https://example.invalid" },
              },
            ],
          },
          "content_block_refused",
        ],
        [
          {
            role: "user",
            content: [
              {
                type: "web_fetch_tool_result",
                tool_use_id: "srvtoolu_1",
                content: {},
              },
            ],
          },
          "content_block_refused",
        ],
        [
          {
            role: "user",
            content: [{ type: "compaction", content: "summary" }],
          },
          "content_block_refused",
        ],
        [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  { type: "document", source: { type: "text", data: "x" } },
                ],
              },
            ],
          },
          "content_block_refused",
        ],
        [
          { role: "user", content: "x", container: { id: "container_1" } },
          "messages_field_refused",
        ],
        // A key Pi never writes on a block of an allowed type.
        [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "x",
                citations: [{ type: "web_search_result_location" }],
              },
            ],
          },
          "content_field_refused",
        ],
        [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "read",
                input: {},
                caller: { type: "code_execution_20260120" },
              },
            ],
          },
          "content_field_refused",
        ],
        [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AA==",
                  url: "https://example.invalid/i.png",
                },
              },
            ],
          },
          "content_field_refused",
        ],
        [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  {
                    type: "text",
                    text: "x",
                    cache_control: { type: "ephemeral" },
                  },
                ],
              },
            ],
          },
          "content_field_refused",
        ],
        // An inherited property name is not a role.
        [{ role: "constructor", content: "x" }, "messages_request_invalid"],
        [{ role: "__proto__", content: "x" }, "messages_request_invalid"],
      ] as [Record<string, unknown>, string][]
    ).map(
      ([message, reason]) =>
        [
          { messages: [{ role: "user", content: "Plan" }, message] },
          reason,
        ] as [Record<string, unknown>, string],
    ),
    [
      {
        system: [
          {
            type: "document",
            source: { type: "url", url: "https://example.invalid" },
          },
        ],
      },
      "content_block_refused",
    ],
    [
      { system: [{ type: "text", text: "x", citations: [] }] },
      "content_field_refused",
    ],
    [
      {
        tools: [
          {
            name: "x",
            input_schema: {},
            allowed_callers: ["code_execution_20260120"],
          },
        ],
      },
      "tool_field_refused",
    ],
    [
      { tools: [{ name: "x", type: "custom", input_schema: {} }] },
      "server_tool_refused",
    ],
    [{ max_tokens: "lots" }, "messages_request_invalid"],
    [{ messages: "none" }, "messages_request_invalid"],
  ];
  for (const [overrides] of cases) {
    const response = await app.inject({
      method: "POST",
      url: url(),
      payload: request(overrides),
      headers,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["x-should-retry"], "false");
    assert.equal(response.json().type, "error");
    assert.equal(response.json().error.type, "invalid_request_error");
  }
  assert.equal(f.messagesRequests().length, 0);
  assert.equal((await calls()).length, 0);
  assert.deepEqual(
    (await events("worker_request_rejected")).map((e) => e.reason).sort(),
    cases.map(([, reason]) => reason).sort(),
  );
  const beta = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers: {
      ...headers,
      "anthropic-beta":
        "mid-conversation-output-config-2026-07-01,mcp-client-2025-11-20",
    },
  });
  assert.equal(beta.statusCode, 400);
  assert.match(beta.json().error.message, /mcp-client-2025-11-20/);
  assert.equal(f.messagesRequests().length, 0);
  const purpose = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers: { ...headers, "x-runtime-purpose": "other" },
  });
  assert.equal(purpose.statusCode, 400);
  // No model runs for a job the owner has not started (journal 191).
  await f.db.query("UPDATE coding_jobs SET mode='plan'");
  for (const role of ["coder", "reviewer"]) {
    const early = await app.inject({
      method: "POST",
      url: url(role),
      payload: request(),
      headers,
    });
    assert.equal(early.statusCode, 401);
  }
  assert.equal(f.messagesRequests().length, 0);
  assert.equal((await calls()).length, 0);
});

test("Anthropic's error reply reaches Pi with its status and retry headers, and is recorded", async (t) => {
  const { f, app, headers, url, settled, calls, events } = await piJob(t);
  f.setMessages(async () => {
    throw Anthropic.APIError.generate(
      429,
      {
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      },
      "429",
      new Headers({ "retry-after": "7", "request-id": "req_429" }),
    );
  });
  const response = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers,
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "7");
  assert.equal(response.json().error.type, "rate_limit_error");
  await settled();
  assert.equal((await calls())[0].state, "uncertain");
  const [rejected] = await events("worker_request_rejected");
  assert.equal(rejected.code, "model_rate_limited");
  assert.equal(rejected.providerStatus, 429);
  assert.equal(rejected.httpStatus, 429);
  // The slot is free again: Pi's own retry can send the next request.
  f.setMessages(async () =>
    messagesResponse({ content: [{ type: "text", text: "ok" }] }),
  );
  const retried = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers,
  });
  assert.equal(retried.statusCode, 200);
  await settled();
  assert.deepEqual(
    (await calls()).map((c) => c.state),
    ["uncertain", "complete"],
  );
});

/** A stream that sends message_start and then waits until its request is aborted. */
function hanging(signal: AbortSignal) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(messageStart({ usage: { input_tokens: 4000 } })),
        );
        signal.addEventListener(
          "abort",
          () => controller.error(new Error("aborted")),
          { once: true },
        );
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

for (const stop of ["cancel", "deadline", "disconnect"] as const)
  test(`a ${stop} stops the in-flight call and records what was billed`, async (t) => {
    const { f, job, app, headers, url, settled, calls, events } =
      await piJob(t);
    let upstream: AbortSignal | undefined;
    f.setMessages(async (_body, _betas, signal) => {
      upstream = signal;
      return hanging(signal);
    });
    if (stop === "deadline")
      await f.db.query(
        "UPDATE coding_jobs SET attempt_deadline=$2 WHERE id=$1",
        [job.id, new Date(Date.now() + 300)],
      );
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };
    const client = new AbortController();
    const reply = fetch(`http://127.0.0.1:${address.port}${url()}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(request()),
      signal: client.signal,
    });
    const response = await reply;
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    await reader.read();
    if (stop === "cancel") (f.c as any).abortModels(job.id);
    if (stop === "disconnect") client.abort();
    if (stop !== "disconnect")
      await assert.rejects(async () => {
        for (;;) if ((await reader.read()).done) throw new Error("ended");
      });
    await settled();
    assert.equal(upstream!.aborted, true);
    assert.equal((await calls())[0].state, "uncertain");
    const [rejected] = await events("worker_request_rejected");
    assert.equal(
      rejected.code,
      {
        cancel: "model_cancelled",
        deadline: "model_timeout",
        disconnect: "model_disconnected",
      }[stop],
    );
    if (stop === "deadline") assert.equal(rejected.timeoutKind, "total");
    const [usage] = await events("model_usage");
    assert.equal(usage.incomplete, true);
    assert.equal(usage.usage.prompt_tokens, 4000);
    // The aborted client's keep-alive socket would otherwise hold the server open.
    app.server.closeAllConnections();
  });

test("Pi jobs and coding model choices must use a model Chief calls directly at Anthropic", async (t) => {
  const f = await fixture(t, {
    settings: { ...settings, runtime: "pi", model: "unrouted/model" },
  });
  await assert.rejects(
    f.start("unrouted"),
    /Coding jobs call Claude directly at Anthropic, and unrouted\/model is not a Claude model Chief calls directly.*No job was started/,
  );
  const g = await fixture(t, { settings: { ...settings, runtime: "pi" } });
  await assert.rejects(
    g.c.call("a", g.run, {
      operation: "coding_model_set",
      role: "coder",
      model: "unrouted/model",
    }),
    /unrouted\/model is not a Claude model Chief calls directly.*No setting was changed/,
  );
});

/**
 * A real Pi session in a git workspace, through the real host route and the Anthropic SDK, to a
 * local fake of the Messages API. `respond` answers the n-th upstream request (1-based).
 */
async function throughHost(
  t: TestContext,
  respond: (n: number, body: any, res: ServerResponse) => void,
  files: Record<string, string | Buffer> = {},
  options: {
    /** The worker's effort, when it should differ from the job's ("medium"). */
    workerEffort?: "low" | "medium" | "high";
    /** The host refuses connections for this long before it starts listening. */
    outageMs?: number;
    workspaceId?: string;
    /** A small window makes Pi compact. */
    contextWindow?: number;
  } = {},
) {
  const upstream: { headers: Record<string, unknown>; body: any }[] = [];
  const anthropicApi = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    upstream.push({ headers: req.headers, body });
    respond(upstream.length, body, res);
  });
  await new Promise<void>((resolve) =>
    anthropicApi.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => anthropicApi.close(() => resolve())),
  );
  const gateway = new AnthropicMessagesGateway("host-anthropic-key", {
    baseURL: `http://127.0.0.1:${(anthropicApi.address() as AddressInfo).port}`,
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
  });
  const f = await fixture(t, {
    anthropic: {
      route: () => ({
        nativeModel: "claude-opus-5-5",
        prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      }),
      send: (body, wire, signal) => gateway.send(body, wire, signal),
    },
  });
  const started = await f.start("pi-e2e");
  await f.c.tick();
  let job = await f.row(started.id);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
      effort: "medium",
      maxOutputTokens: 32000,
      limits: { ...settings.limits, models: 400 },
    }),
  ]);
  job = await f.row(job.id);
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  let port: number;
  if (options.outageMs) {
    // A free port that refuses connections until the host starts, as during a restart.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    setTimeout(
      () => void app.listen({ port, host: "127.0.0.1" }),
      options.outageMs,
    );
  } else {
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  }
  const host = `http://127.0.0.1:${port}`;
  const token = f.c.token(job.id, job.attempt_id);
  const root = await mkdtemp(join(tmpdir(), "pi-host-protocol-"));
  const workspace = join(root, "work");
  await mkdir(workspace);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], { stdio: "pipe" });
  await writeFile(join(workspace, "sum.js"), "// synthetic\n");
  for (const [name, content] of Object.entries(files))
    await writeFile(join(workspace, name), content);
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  );
  const runtime = new CodingRuntime({
    store: new TaskStore(
      join(root, "state"),
      "synthetic-state-key-32-characters",
    ),
    model: anthropicModel({
      model: "claude-opus-5-5",
      baseUrl: `${host}/coding/worker/${job.id}/pi/coder`,
      apiKey: token,
      maxTokens: 32000,
      reasoning: options.workerEffort ?? "medium",
      ...(options.contextWindow
        ? { contextWindow: options.contextWindow, maxTokens: 16000 }
        : {}),
      // Short delays keep the test quick; the worker's own settings are checked separately.
      ...(options.outageMs
        ? { retry: { maxRetries: 8, baseDelayMs: 200 } }
        : {}),
    }),
    executor: (task: { workspace: string }) =>
      localExecutor(task.workspace, join(root, "home")),
  });
  const task = await runtime.start({
    workspace,
    role: "coder",
    base: execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  });
  const result = await runtime.run(task.id, "Fix the synthetic sum");
  for (let i = 0; i < 200; i++) {
    if (!(await f.row(job.id)).model_busy) break;
    await delay(10);
  }
  const recorded = (
    await f.db.query(
      "SELECT state,result FROM coding_model_calls WHERE job_id=$1 ORDER BY created_at,id",
      [job.id],
    )
  ).rows;
  return { upstream, result, recorded, token, f, job };
}

const sse = (res: ServerResponse, turn: FakeTurn) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(messagesStream(turn));
};
const doneReport = toolUse("toolu_report", "report", {
  kind: "done",
  summary: "Fix café sum",
  detail: "Use addition in sum.js and check sum(2,3)=5.",
});

test("through the host, Pi resends the first response's content blocks byte for byte", async (t) => {
  const turns: FakeTurn[] = [
    {
      id: "msg_first",
      content: [
        { type: "thinking", thinking: "", signature: "Zmlyc3Qtc2lnbmF0dXJl" },
        { type: "text", text: "Reading the café source" },
        toolUse("toolu_first", "read", { path: "sum.js" }),
      ],
    },
    {
      id: "msg_second",
      content: [
        { type: "thinking", thinking: "Summary", signature: "c2Vjb25k" },
        doneReport,
      ],
    },
  ];
  const { upstream, result, recorded, token } = await throughHost(
    t,
    (n, _body, res) => sse(res, turns[n - 1]!),
  );
  assert.equal(result.status, "completed", result.summary);
  assert.equal(upstream.length, 2);
  // The second request carries the first response's blocks exactly as Anthropic sent them.
  const replayed = upstream[1]!.body.messages.filter(
    (m: any) => m.role === "assistant",
  );
  assert.equal(replayed.length, 1);
  assert.equal(
    JSON.stringify(replayed[0].content),
    JSON.stringify(turns[0]!.content),
  );
  for (const { headers, body } of upstream) {
    // The host's key reaches Anthropic; the worker's capability never does.
    assert.equal(headers.authorization, "Bearer host-anthropic-key");
    // Pi's API version travels with its request.
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert(!JSON.stringify(headers).includes(token));
    assert.match(
      String(headers["anthropic-beta"]),
      /mid-conversation-output-config-2026-07-01/,
    );
    assert.equal(body.max_tokens, 32000);
    assert.deepEqual(body.output_config, { effort: "medium" });
  }
  assert.deepEqual(
    recorded.map((r: any) => r.state),
    ["complete", "complete"],
  );
  assert.deepEqual(
    recorded.map((r: any) => r.result.content),
    turns.map((turn) => turn.content),
  );
});

test("a 429 mid-session is retried by Pi's stock retry and the session carries on", async (t) => {
  const { upstream, result, recorded, f } = await throughHost(
    t,
    (n, _body, res) => {
      if (n === 2) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "1",
        });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Rate limited" },
          }),
        );
        return;
      }
      sse(res, {
        content: [
          n === 1
            ? toolUse("toolu_read", "read", { path: "sum.js" })
            : doneReport,
        ],
      });
    },
  );
  assert.equal(result.status, "completed", result.summary);
  assert.equal(upstream.length, 3);
  // The retry is the same request: the failed call never entered the session.
  assert.deepEqual(upstream[2]!.body.messages, upstream[1]!.body.messages);
  assert.deepEqual(
    recorded.map((r: any) => r.state),
    ["complete", "uncertain", "complete"],
  );
  const rejected = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE payload->>'kind'='worker_request_rejected'",
    )
  ).rows.map((r: any) => r.payload);
  assert.deepEqual(
    rejected.map((e: any) => [e.code, e.providerStatus]),
    [["model_rate_limited", 429]],
  );
});

test("an image the model reads reaches Anthropic as an image block", async (t) => {
  // A 1x1 PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const { upstream, result } = await throughHost(
    t,
    (n, _body, res) =>
      sse(res, {
        content: [
          n === 1
            ? toolUse("toolu_img", "read", { path: "pixel.png" })
            : doneReport,
        ],
      }),
    { "pixel.png": png },
  );
  assert.equal(result.status, "completed", result.summary);
  const results = upstream[1]!.body.messages.flatMap((m: any) =>
    Array.isArray(m.content)
      ? m.content.filter((b: any) => b.type === "tool_result")
      : [],
  );
  const image = results
    .flatMap((r: any) => (Array.isArray(r.content) ? r.content : []))
    .find((b: any) => b.type === "image");
  assert(image, JSON.stringify(results));
  assert.equal(image.source.type, "base64");
  assert.equal(image.source.media_type, "image/png");
  assert(image.source.data.length > 0);
});

test("a failed connection to Anthropic is left to Pi's retry, and an error inside the stream is recorded", async (t) => {
  const { f, app, headers, url, settled, calls, events } = await piJob(t);
  f.setMessages(async () => {
    throw new Anthropic.APIConnectionError({ message: "Connection error." });
  });
  const failed = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers,
  });
  assert.equal(failed.statusCode, 502);
  // Pi's stock retry policy decides; the host does not forbid a retry.
  assert.equal(failed.headers["x-should-retry"], undefined);
  await settled();
  // Anthropic can end a started stream with an error event (for example overloaded).
  const stream =
    messageStart({ usage: { input_tokens: 900 } }) +
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`;
  f.setMessages(
    async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const broken = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers,
  });
  assert.equal(broken.statusCode, 200);
  // Pi reads the error event itself.
  assert.equal(broken.body, stream);
  await settled();
  assert.deepEqual(
    (await calls()).map((c) => c.state),
    ["uncertain", "uncertain"],
  );
  assert.deepEqual(
    (await events("worker_request_rejected")).map((e) => e.code).sort(),
    ["model_disconnected", "model_transient_failure"],
  );
  const [usage] = await events("model_usage");
  assert.equal(usage.incomplete, true);
  assert.equal(usage.usage.prompt_tokens, 900);
});

test("a body field the SDK would turn into a header never reaches Anthropic, and the host's workspace is the one sent", async (t) => {
  const { upstream, result } = await throughHost(
    t,
    (n, _body, res) =>
      sse(res, {
        content: [
          n === 1
            ? toolUse("toolu_read", "read", { path: "sum.js" })
            : doneReport,
        ],
      }),
    {},
    { workspaceId: "wrkspc_host" },
  );
  assert.equal(result.status, "completed", result.summary);
  for (const { headers } of upstream)
    assert.equal(headers["anthropic-workspace-id"], "wrkspc_host");
  // A forged request with workspace_id in the body is refused before any call.
  const { f, app, headers, url } = await piJob(t);
  const forged = await app.inject({
    method: "POST",
    url: url(),
    payload: request({ workspace_id: "wrkspc_attacker" }),
    headers,
  });
  assert.equal(forged.statusCode, 400);
  assert.match(forged.json().error.message, /workspace_id/);
  assert.equal(f.messagesRequests().length, 0);
});

test("a request with a web_fetch server tool and mcp_servers is refused with no upstream call", async (t) => {
  const { f, app, headers, url, calls } = await piJob(t);
  const response = await app.inject({
    method: "POST",
    url: url(),
    payload: request({
      tools: [
        ...request().tools,
        { type: "web_fetch_20260209", name: "web_fetch" },
      ],
      mcp_servers: [{ type: "url", url: "https://example.invalid", name: "x" }],
    }),
    headers,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(f.messagesRequests().length, 0);
  assert.equal((await calls()).length, 0);
});

test("Pi's per-turn effort marker must match the job; a request with no marker runs at the job's effort", async (t) => {
  // A real Pi session whose effort differs from the job's: its first request carries Pi's
  // marker ("low") and is refused before any call.
  const refused = await throughHost(
    t,
    () => {
      throw new Error("No request may reach Anthropic");
    },
    {},
    { workerEffort: "low" },
  );
  assert.equal(refused.upstream.length, 0);
  assert.equal(refused.result.status, "paused");
  const reasons = (
    await refused.f.db.query(
      "SELECT payload FROM coding_events WHERE payload->>'kind'='worker_request_rejected'",
    )
  ).rows.map((r: any) => r.payload.reason);
  assert(reasons.includes("effort_not_pinned"), JSON.stringify(reasons));
  // A request without markers: the top-level effort the host sets is the job's, not Pi's "high".
  const { f, app, headers, url, settled } = await piJob(t);
  const body = request({
    messages: [{ role: "user", content: "Plan the fix" }],
    output_config: { effort: "high" },
  });
  const response = await app.inject({
    method: "POST",
    url: url(),
    payload: body,
    headers,
  });
  assert.equal(response.statusCode, 200);
  await settled();
  assert.deepEqual(f.messagesRequests()[0]!.body.output_config, {
    effort: "medium",
  });
});

test("requests for one job queue for the slot, and Pi's cache warming is recorded apart", async (t) => {
  const { f, job, app, headers, url, settled, calls } = await piJob(t);
  // Recording each call is slow, so later requests arrive while one is in flight.
  const query = f.db.query.bind(f.db);
  (f.db as any).query = async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("UPDATE coding_jobs SET model_busy=false"))
      await new Promise((resolve) => setTimeout(resolve, 50));
    return query(sql, params as any);
  };
  const send = (body: Record<string, unknown>, purpose?: string) =>
    app.inject({
      method: "POST",
      url: url(),
      payload: request(body),
      headers: {
        ...headers,
        ...(purpose ? { "x-runtime-purpose": purpose } : {}),
      },
    });
  const before = (await f.row(job.id)).used_models;
  // A real request and a warm one together, then two more: none is refused.
  const replies = await Promise.all([
    send({}),
    send({ max_tokens: 1 }, "cache_warm"),
    send({}),
    send({}),
  ]);
  assert.deepEqual(
    replies.map((r) => r.statusCode),
    [200, 200, 200, 200],
  );
  await settled();
  const recorded = await calls();
  assert.deepEqual(
    recorded.map((c) => c.state),
    ["complete", "complete", "complete", "complete"],
  );
  assert.equal(
    recorded.filter((c) => c.input.purpose === "cache_warm").length,
    1,
  );
  // The warm request is not counted as an agent call.
  assert.equal((await f.row(job.id)).used_models, before + 3);
  // Only a one-token replay may claim the warming purpose.
  const forged = await send({ max_tokens: 100 }, "cache_warm");
  assert.equal(forged.statusCode, 400);
});
test("a request sent right after the previous stream ends waits for the slot instead of being refused", async (t) => {
  const { f, app, headers, url, settled, calls } = await piJob(t);
  // Recording the first call is slow; the next request arrives meanwhile.
  let gate!: () => void;
  const opened = new Promise<void>((resolve) => (gate = resolve));
  const query = f.db.query.bind(f.db);
  (f.db as any).query = async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("UPDATE coding_jobs SET model_busy=false")) await opened;
    return query(sql, params as any);
  };
  const first = await app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers,
  });
  assert.equal(first.statusCode, 200);
  const second = app.inject({
    method: "POST",
    url: url(),
    payload: request(),
    headers,
  });
  setTimeout(gate, 100);
  assert.equal((await second).statusCode, 200);
  await settled();
  assert.deepEqual(
    (await calls()).map((c) => c.state),
    ["complete", "complete"],
  );
});

test("a host that refuses connections for a while (a gateway restart) does not end the session", async (t) => {
  const { upstream, result } = await throughHost(
    t,
    (n, _body, res) =>
      sse(res, {
        content: [
          n === 1
            ? toolUse("toolu_read", "read", { path: "sum.js" })
            : doneReport,
        ],
      }),
    {},
    { outageMs: 1500 },
  );
  assert.equal(result.status, "completed", result.summary);
  assert.equal(upstream.length, 2);
});

test("the worker keeps retrying the host for about four minutes, longer than a release takes", () => {
  let total = 0;
  for (let attempt = 1; attempt <= GATEWAY_RETRY.maxRetries; attempt++)
    total += retryDelayMs(
      {
        baseDelayMs: 2000,
        maxAgentDelayMs: 60000,
        ...GATEWAY_RETRY,
      } as any,
      attempt,
    );
  assert(total >= 180000, String(total));
});

test("1-hour cache writes are priced at twice the input price", () => {
  const prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
  const usage = anthropicUsage(
    {
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1000,
        cache_creation: {
          ephemeral_5m_input_tokens: 400,
          ephemeral_1h_input_tokens: 600,
        },
      } as any,
    },
    prices,
  );
  assert.equal(usage.cost, (100 * 4 + 400 * 5 + 600 * 4 * 2 + 10 * 20) / 1e6);
  // Without the breakdown every write is a 5-minute write.
  assert.equal(
    anthropicUsage(
      {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1000,
        } as any,
      },
      prices,
    ).cost,
    (1000 * 5) / 1e6,
  );
});

test("a real Pi session's report reminder and Pi's own compaction call pass the host's allowlists", async (t) => {
  const rejections = async (f: {
    db: { query: (sql: string) => Promise<any> };
  }) =>
    (
      await f.db.query(
        "SELECT payload FROM coding_events WHERE payload->>'kind'='worker_request_rejected'",
      )
    ).rows;
  // (a) A turn that ends in prose without a report: the runtime sends one reminder in the
  // same session, as an ordinary user message (journal 192).
  let reminded = false;
  const prose = await throughHost(t, (_n, body, res) => {
    reminded ||= JSON.stringify(body.messages).includes(reportReminder);
    sse(res, {
      content: [
        reminded
          ? doneReport
          : { type: "text", text: "sum.js subtracts; it should add." },
      ],
    });
  });
  assert(reminded, "Pi sent the reminder");
  assert.equal(prose.result.status, "completed", prose.result.summary);
  assert.deepEqual(await rejections(prose.f), []);
  // (b) A build whose reported context fills a small window: Pi makes a summary call.
  let compactions = 0;
  let turns = 0;
  const built = await throughHost(
    t,
    (_n, body, res) => {
      if (!body.tools?.length) {
        compactions++;
        sse(res, {
          content: [
            {
              type: "text",
              text: "Working state: sum.js inspected; use addition, then report done.",
            },
          ],
          usage: { input_tokens: 2000, output_tokens: 100 },
        });
        return;
      }
      turns++;
      sse(res, {
        content: [
          compactions > 0
            ? toolUse("toolu_done", "report", {
                kind: "done",
                summary: "Done",
                detail: "Synthetic build finished after compaction.",
              })
            : toolUse(`toolu_b${turns}`, "read", { path: "sum.js" }),
        ],
        usage: { input_tokens: 35000, output_tokens: 100 },
      });
    },
    // A large file, so each read fills the small window.
    {
      "sum.js":
        Array.from(
          { length: 200 },
          (_, i) =>
            `export const rule_${i} = ${JSON.stringify({ id: i, text: "Retain the documented validation behavior and source evidence across context maintenance." })};`,
        ).join("\n") + "\n",
    },
    { contextWindow: 40000 },
  );
  assert(compactions > 0, "Pi made a compaction call");
  assert.deepEqual(await rejections(built.f), []);
  assert.equal(built.result.status, "completed", built.result.summary);
});

test("a request whose worker hung up while waiting for the slot costs nothing", async (t) => {
  const { f, job, settled, calls } = await piJob(t);
  let open!: () => void;
  (f.c as any).piSlots.set(
    job.id,
    new Promise<void>((resolve) => (open = resolve)),
  );
  const gone = new AbortController();
  const reply = f.c.piMessages(job, "coder", request(), {
    signal: gone.signal,
  });
  gone.abort();
  open();
  const response = await reply;
  assert.equal(response.status, 400);
  await settled();
  assert.equal((await calls()).length, 0);
  assert.equal((await f.row(job.id)).used_models, job.used_models);
  assert.equal(f.messagesRequests().length, 0);
});
