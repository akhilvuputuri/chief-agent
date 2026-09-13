import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  contentHash,
  PluginRegistry,
  readBundle,
  validateBundle,
  type PluginBundle,
} from "../src/plugins.js";
import { pluginCommand } from "../src/plugin-cli.js";
import { pinPlugin } from "../src/plugin-execution.js";
import { plugins } from "../src/plugin-registry.js";
import { Execution } from "../src/execution.js";
import { ensureUser, type Database } from "../src/db.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import { runtimeContext } from "../src/runtime.js";
import { SkillTools } from "../src/skills.js";
const original = () =>
  readBundle(new URL("../plugins/public-research", import.meta.url).pathname);
function install(
  root: string,
  bundle = original(),
  grants = ["web_search", "web_read", "source_read"],
) {
  const directory = join(root, "package");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "plugin.json"),
    JSON.stringify(bundle.manifest),
  );
  for (const [p, content] of Object.entries(bundle.files)) {
    const path = join(directory, p);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  writeFileSync(
    join(root, "registry.json"),
    JSON.stringify({
      format: "companion.plugin-registry/v1",
      researchAgent: "public-research/researcher",
      enabled: [
        {
          path: "package",
          sha256: contentHash(bundle),
          agents: ["researcher"],
          allowTools: grants,
        },
      ],
    }),
  );
  return new PluginRegistry(root);
}
function temp() {
  return mkdtempSync(join(tmpdir(), "companion-plugins-test-"));
}
async function database() {
  const pg = new PGlite();
  for (const name of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "008_costs",
    "012_message_storage",
    "013_conversation_control",
    "014_checkpoint_steering",
  ])
    await pg.exec(
      readFileSync(new URL(`../db/${name}.sql`, import.meta.url), "utf8"),
    );
  return { pg, db: pg as unknown as Database };
}

test("portable bundle round trip preserves content identity; import is inactive and cannot overwrite", () => {
  const root = temp();
  try {
    const bundle = join(root, "export.json"),
      target = join(root, "imported");
    const exported = pluginCommand(
      "export",
      new URL("../plugins/public-research", import.meta.url).pathname,
      bundle,
    ) as any;
    const imported = pluginCommand("import", bundle, target) as any;
    assert.equal(imported.enabled, false);
    assert.equal(imported.sha256, exported.sha256);
    assert.deepEqual(readBundle(target), original());
    assert.throws(
      () => pluginCommand("import", bundle, target),
      /already exists/,
    );
    assert.throws(() => pluginCommand("export", target, bundle), /EEXIST/);
    assert(!readFileSync(bundle, "utf8").includes("allowTools"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported code/hooks/contracts, paths, missing dependencies and duplicate IDs are rejected", () => {
  const changes: ((b: any) => void)[] = [
    (b) => (b.manifest.hooks = { start: "exec" }),
    (b) => (b.manifest.agents[0].contract = "shell/v1"),
    (b) => b.manifest.agents[0].tools.push("calendar_draft"),
    (b) => (b.manifest.agents[0].limits.models = 100),
    (b) => (b.manifest.agents[0].instructions = "../outside.md"),
    (b) => b.manifest.agents.push(b.manifest.agents[0]),
    (b) => b.manifest.agents[0].skills.push("missing"),
    (b) => (b.files["hooks/run.js"] = "process.exit()"),
    (b) => delete b.files["agents/researcher.md"],
    (b) => (b.files["skills/source-research/SKILL.md"] = "No frontmatter"),
    (b) => (b.files["agents/researcher.md"] = "x".repeat(32001)),
  ];
  for (const change of changes) {
    const b = original();
    change(b);
    assert.throws(() => validateBundle(b));
  }
});

test("registry requires content pins and host grants; returns immutable copies and compact catalogue", () => {
  const root = temp();
  try {
    const registry = install(root);
    assert.equal(registry.get("public-research/researcher").limits.models, 8);
    const copy = registry.get("public-research/researcher");
    copy.tools.pop();
    assert.equal(registry.get(copy.agentId).tools.length, 3);
    assert(
      !JSON.stringify(registry.catalogue()).includes(
        "Avoid redundant searches",
      ),
    );
    assert.throws(() => registry.get("other/researcher"), /not enabled/);
    assert.throws(
      () => install(root, original(), ["web_read"]),
      /has not granted/,
    );
    install(root);
    writeFileSync(
      join(root, "package/agents/researcher.md"),
      "Changed instructions",
    );
    assert.throws(() => new PluginRegistry(root), /hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package symlinks and executable skill attachments are unsupported", () => {
  const root = temp();
  try {
    install(root);
    const file = join(root, "package/agents/researcher.md");
    rmSync(file);
    symlinkSync(join(root, "registry.json"), file);
    assert.throws(() => readBundle(join(root, "package")), /symlinks/);
    const bundle = original() as any;
    bundle.manifest.skills[0].scripts = ["script.py"];
    assert.throws(() => validateBundle(bundle));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host override comes from registry; package cannot pick a model or grant permissions", () => {
  const root = temp();
  try {
    install(root);
    const path = join(root, "registry.json"),
      config = JSON.parse(readFileSync(path, "utf8"));
    config.enabled[0].model = "example/research-model";
    writeFileSync(path, JSON.stringify(config));
    assert.equal(
      new PluginRegistry(root).get("public-research/researcher").model,
      "example/research-model",
    );
    const bundle = original() as any;
    bundle.manifest.agents[0].model = "example/research-model";
    assert.throws(() => validateBundle(bundle));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task pins survive a new registry, preserve approved private skills, isolate owners and respect revocation", async () => {
  const root = temp(),
    { pg, db } = await database();
  try {
    await ensureUser(db, "owner");
    await ensureUser(db, "other");
    const task = randomUUID(),
      version = randomUUID();
    await db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request) VALUES($1,'owner','Research','Research')",
      [task],
    );
    await db.query(
      "INSERT INTO skill_versions(id,user_id,key,content,reason) VALUES($1,'owner','public-research/source-research','APPROVED PRIVATE PROCEDURE','Test')",
      [version],
    );
    await db.query(
      "INSERT INTO skill_heads(user_id,key,version_id) VALUES('owner','public-research/source-research',$1)",
      [version],
    );
    async function execution(user: string, taskId: string | null) {
      const run = randomUUID();
      await db.query(
        "INSERT INTO work_turns(run_id,user_id,request,task_id) VALUES($1,$2,'Research',$3)",
        [run, user, taskId],
      );
      const e = new Execution(db, user, run, new AbortController().signal);
      await e.start();
      return e;
    }
    const registry = install(root),
      first = await execution("owner", task);
    const old = await pinPlugin(first, "public-research/researcher", registry);
    assert.equal(
      old.skillDefinitions[0]?.content,
      "APPROVED PRIVATE PROCEDURE",
    );
    assert.equal(old.skillDefinitions[0]?.version, `private:${version}`);
    const changed = original();
    changed.manifest.version = "1.0.1";
    changed.files["agents/researcher.md"] += "\nNEW INSTRUCTIONS";
    const updated = install(root, changed);
    const resumed = await pinPlugin(
      await execution("owner", task),
      old.agentId,
      updated,
    );
    assert.equal(resumed.pluginHash, old.pluginHash);
    assert(!resumed.instructions.includes("NEW INSTRUCTIONS"));
    const other = await pinPlugin(
      await execution("other", null),
      old.agentId,
      updated,
    );
    assert.equal(other.pluginVersion, "1.0.1");
    assert(!other.skillDefinitions[0]?.content.includes("PRIVATE"));
    const empty = join(root, "empty");
    mkdirSync(empty);
    writeFileSync(
      join(empty, "registry.json"),
      JSON.stringify({
        format: "companion.plugin-registry/v1",
        researchAgent: null,
        enabled: [],
      }),
    );
    await assert.rejects(
      pinPlugin(first, old.agentId, new PluginRegistry(empty)),
      /not enabled/,
    );
    const pins = (
      await db.query(
        "SELECT * FROM events WHERE type='plugin.pinned' AND user_id='owner'",
      )
    ).rows;
    assert.equal(pins.length, 1);
    await db.query(
      "UPDATE events SET data=jsonb_set(data,'{definitionHash}','\"bad\"') WHERE id=$1",
      [pins[0].id],
    );
    await assert.rejects(pinPlugin(first, old.agentId, registry), /integrity/);
  } finally {
    await pg.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic plugin delegation discovers agents, loads only assigned skills lazily and rejects recursive calls", async () => {
  const { pg, db } = await database();
  let coordinatorCalls = 0,
    childCalls = 0;
  const call = (name: string, args: unknown) => ({
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  });
  const obs = (input: any) =>
    JSON.parse(input.messages.findLast((m: any) => m.role === "tool").content);
  try {
    const assistant = new Assistant(
      db,
      new CustomAgent({
        generate: async (input) => {
          if (
            String(input.messages[0]?.content).includes(
              "read-only research specialist",
            )
          ) {
            childCalls++;
            if (childCalls === 1) {
              assert(
                !JSON.stringify(input.messages).includes(
                  "Treat search as discovery",
                ),
              );
              return call("skill_read", {
                key: "public-research/source-research",
              });
            }
            if (childCalls === 2) {
              assert.match(
                obs(input).result.version.content,
                /Treat search as discovery/,
              );
              return call("skill_read", { key: "job-alignment" });
            }
            if (childCalls === 3) {
              assert.equal(obs(input).error.code, "VALIDATION_FAILED");
              return call("plugin_delegate", {
                agentId: "public-research/researcher",
                objective: "Recursive",
                context: "",
                jobIds: [],
                urls: [],
              });
            }
            assert(obs(input).error);
            return call("research_report", {
              targets: [
                {
                  targetId: "topic",
                  status: "blocked",
                  summary: "No evidence available",
                  evidence: [],
                },
              ],
            });
          }
          if (++coordinatorCalls === 1) {
            assert(
              JSON.stringify(input.messages).includes(
                "public-research/researcher",
              ),
            );
            return call("plugin_delegate", {
              agentId: "public-research/researcher",
              objective: "Investigate platform",
              context: "",
              jobIds: [],
              urls: [],
            });
          }
          assert.equal(obs(input).result.targets[0].status, "blocked");
          return {
            message: {
              role: "assistant" as const,
              content: "Research is blocked by missing evidence.",
            },
          };
        },
      }),
      new JobTools(db, { call: async () => ({}) }),
      { web: true },
    );
    assert.match(
      await assistant.respond("owner", "Research the platform"),
      /blocked/,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM events WHERE type='plugin.skill_read'",
        )
      ).rows[0].n,
      1,
    );
    const child = (
      await db.query(
        "SELECT data FROM events WHERE type='research.child_started'",
      )
    ).rows[0].data;
    assert.equal(
      child.plugin.sha256,
      plugins.get("public-research/researcher").pluginHash,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM runtime_runs")).rows[0].n,
      2,
    );
    const off = runtimeContext({ web: false }, null);
    assert(!off.tools.some((t) => t.name === "plugin_delegate"));
    const skill = (await new SkillTools(db).call("owner", randomUUID(), {
      operation: "skill_read",
      key: "public-research/source-research",
    })) as any;
    assert.match(skill.version.content, /Treat search as discovery/);
  } finally {
    await pg.close();
  }
});

test("long accepted plugin skills are fully readable through actual child observations", async () => {
  const { delegateResearch } = await import("../src/research.js");
  const root = temp(),
    { pg, db } = await database();
  const bundle = original();
  bundle.files["skills/source-research/SKILL.md"] +=
    "\n" +
    '"quoted"\\instruction\n'.repeat(750) +
    "\nFINAL RULE: never replace the assigned target.";
  let collected = "",
    calls = 0;
  try {
    const registry = install(root, validateBundle(bundle));
    const definition = registry.get("public-research/researcher");
    await ensureUser(db, "owner");
    const signal = new AbortController().signal,
      runId = randomUUID();
    const execution = new Execution(db, "owner", runId, signal);
    await execution.start();
    const runtime = runtimeContext({ web: true }, null);
    const result = await delegateResearch(
      {
        runId,
        capability: "",
        execution,
        signal,
        history: [],
        memories: [],
        message: "Research",
        runtime,
        executeResearch: async () => {
          throw new Error("Unexpected research read");
        },
      },
      {
        operation: "research_delegate",
        objective: "Read the complete procedure",
        context: "",
        jobIds: [],
        urls: [],
      },
      async (req) =>
        new CustomAgent({
          generate: async (input) => {
            let next: number | null = 0;
            if (++calls > 1) {
              const observation = JSON.parse(
                String(
                  input.messages.findLast((m) => m.role === "tool")?.content,
                ),
              ).result;
              assert(
                observation.version,
                "Projection must retain the complete page object",
              );
              assert(!observation.truncated);
              collected += observation.version.content;
              next = observation.nextOffset;
            }
            const name = next === null ? "research_report" : "skill_read";
            const args =
              next === null
                ? {
                    targets: [
                      {
                        targetId: "topic",
                        status: "blocked",
                        summary: "No public evidence",
                        evidence: [],
                      },
                    ],
                  }
                : { key: "public-research/source-research", offset: next };
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: randomUUID(),
                    type: "function",
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
            };
          },
        }).run(req),
      definition,
    );
    assert.equal(result.status, "reported");
    assert.equal(collected, bundle.files["skills/source-research/SKILL.md"]);
    assert.match(collected, /FINAL RULE: never replace the assigned target/);
    assert(calls > 2 && calls <= 8);
    const tools = new SkillTools(db);
    const page = (await tools.call("owner", runId, {
      operation: "skill_read",
      key: "public-research/source-research",
      offset: 0,
    })) as any;
    assert.equal(page.offset, 0);
    await assert.rejects(
      tools.call("owner", runId, {
        operation: "skill_read",
        key: "public-research/source-research",
        offset: 32000,
      }),
      /offset/,
    );
  } finally {
    await pg.close();
    rmSync(root, { recursive: true, force: true });
  }
});
