// Synthetic SDK research probe. No model API or Chief connection is used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createReadTool,
  createEditTool,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const root = await mkdtemp(join(tmpdir(), "pi-sdk-probe-"));
const cwd = join(root, "workspace");
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, "example.txt"), "first\nsecond\n");
await writeFile(join(root, "outside.txt"), "synthetic outside marker");
const results = {};
const read = createReadTool(cwd);
const range = await read.execute("range", {
  path: "example.txt",
  offset: 2,
  limit: 1,
});
assert(
  range.content.some((x) => x.type === "text" && x.text.includes("second")),
);
results.lineRead = true;
const escape = await read.execute("outside", { path: "../outside.txt" });
assert(
  escape.content.some(
    (x) => x.type === "text" && x.text.includes("synthetic outside marker"),
  ),
);
results.cwdIsNotSandbox = true;
const edit = createEditTool(cwd);
await edit.execute("edit", {
  path: "example.txt",
  edits: [{ oldText: "second", newText: "changed" }],
});
assert.equal(
  await readFile(join(cwd, "example.txt"), "utf8"),
  "first\nchanged\n",
);
results.targetedEdit = true;
await assert.rejects(
  edit.execute("stale", {
    path: "example.txt",
    edits: [{ oldText: "second", newText: "oops" }],
  }),
);
results.staleEditRejected = true;
const runtime = await ModelRuntime.create({
  authPath: join(root, "auth.json"),
  modelsPath: null,
  modelsStorePath: join(root, "models-cache.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
let calls = 0;
const contexts = [];
runtime.registerProvider("research-mock", {
  api: "research-mock",
  baseUrl: "https://unused.invalid",
  apiKey: "synthetic-unused",
  models: [
    {
      id: "synthetic",
      name: "Synthetic",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 2048,
    },
  ],
  streamSimple(model, context) {
    calls++;
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Synthetic response." }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  },
});
const resources = {
  getExtensions: () => ({
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Synthetic offline probe.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
const manager = SessionManager.inMemory(cwd);
const opts = {
  cwd,
  agentDir: join(root, "agent"),
  modelRuntime: runtime,
  model: runtime.getModel("research-mock", "synthetic"),
  thinkingLevel: "off",
  resourceLoader: resources,
  tools: ["read", "grep", "find", "ls"],
  sessionManager: manager,
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  }),
};
const { session } = await createAgentSession(opts);
assert.deepEqual(session.getActiveToolNames().sort(), [
  "find",
  "grep",
  "ls",
  "read",
]);
results.readOnlyToolSelection = true;
const events = [];
session.subscribe((event) => events.push(event.type));
await session.prompt("Synthetic prompt only.");
assert.equal(calls, 1);
assert.equal(session.getLastAssistantText(), "Synthetic response.");
assert(events.includes("agent_settled"));
results.customProviderAndSettledEvent = true;
const entries = structuredClone([manager.getHeader(), ...manager.getEntries()]);
session.dispose();
const restored = SessionManager.inMemory(cwd, undefined, entries);
const { session: again } = await createAgentSession({
  ...opts,
  sessionManager: restored,
});
assert(
  again.messages.some(
    (m) =>
      m.role === "assistant" &&
      m.content.some(
        (x) => x.type === "text" && x.text === "Synthetic response.",
      ),
  ),
);
assert.equal(calls, 1);
results.inMemoryRestoreWithoutModelCall = true;
again.dispose();
console.log(
  JSON.stringify(
    {
      node: process.version,
      pi: "1.1.0",
      syntheticProviderCalls: calls,
      externalModelCalls: 0,
      results,
    },
    null,
    2,
  ),
);
