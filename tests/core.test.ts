import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { JobTools } from "../src/tools.js";
import { ensureUser, type Database } from "../src/db.js";
import { Assistant, type Agent } from "../src/agent.js";
import { server } from "../src/server.js";
import {
  authorized,
  allowedChat,
  publicHttps,
  SerialQueue,
} from "../src/security.js";
import { action } from "../src/protocol.js";
let pg: PGlite;
let db: Database;
let tools: JobTools;
before(async () => {
  pg = new PGlite();
  await pg.exec(
    await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
  );
  db = pg as unknown as Database;
  tools = new JobTools(db, {
    call: async () => ({ untrusted: true, content: "test" }),
  });
  await ensureUser(db, "alice");
  await ensureUser(db, "bob");
});
after(async () => {
  await pg.close();
});
const run = () => randomUUID();
async function save(user = "alice") {
  return (await tools.execute(user, run(), {
    operation: "job_save",
    title: "AI Engineer",
    company: "Example",
    description: "Build Python agents",
  })) as any;
}
test("save, list, update and analyze persisted roles with profile evidence", async () => {
  const role = await save();
  await tools.execute("alice", run(), {
    operation: "memory_set",
    key: "background",
    value: "Python developer",
  });
  const changed = (await tools.execute("alice", run(), {
    operation: "job_update",
    id: role.id,
    status: "interested",
    notes: "Ask about evals",
  })) as any;
  assert.equal(changed.status, "interested");
  const listed = (await tools.execute("alice", run(), {
    operation: "job_list",
    status: "interested",
  })) as any[];
  assert.ok(listed.some((x) => x.id === role.id));
  const analysis = (await tools.execute("alice", run(), {
    operation: "job_analyze",
    id: role.id,
  })) as any;
  assert.equal(analysis.role.id, role.id);
  assert.equal(analysis.profile[0].value, "Python developer");
});
test("all role operations enforce ownership", async () => {
  const role = await save();
  for (const operation of ["job_update", "job_analyze", "job_delete"])
    await assert.rejects(() =>
      tools.execute("bob", run(), { operation, id: role.id }),
    );
  assert.deepEqual(
    await tools.execute("bob", run(), { operation: "job_list" }),
    [],
  );
  assert.deepEqual(
    await tools.execute("bob", run(), { operation: "memory_list" }),
    [],
  );
});
test("deletion needs owner approval, consumes once, and deletes only the bound role", async () => {
  const role = await save();
  const other = await save();
  const approval = (await tools.execute("alice", run(), {
    operation: "job_delete",
    id: role.id,
  })) as any;
  assert.equal(
    (await db.query("SELECT id FROM jobs WHERE id=$1", [role.id])).rows.length,
    1,
  );
  await assert.rejects(() => tools.decide("bob", approval.id, true));
  const result = await tools.decide("alice", approval.id, true);
  assert.equal(result.status, "approved");
  await assert.rejects(() => tools.decide("alice", approval.id, true));
  assert.equal(
    (await db.query("SELECT id FROM jobs WHERE id=$1", [role.id])).rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT id FROM jobs WHERE id=$1", [other.id])).rows.length,
    1,
  );
});
test("expired and denied approvals cannot be reused", async () => {
  const role = await save();
  const expired = (await tools.execute("alice", run(), {
    operation: "job_delete",
    id: role.id,
  })) as any;
  await db.query(
    "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(() => tools.decide("alice", expired.id, true));
  const denied = (await tools.execute("alice", run(), {
    operation: "job_delete",
    id: role.id,
  })) as any;
  await tools.decide("alice", denied.id, false);
  await assert.rejects(() => tools.decide("alice", denied.id, true));
  assert.equal(
    (await db.query("SELECT id FROM jobs WHERE id=$1", [role.id])).rows.length,
    1,
  );
});
test("invalid status, extra identity fields, and arbitrary shell requests are rejected", () => {
  assert.equal(
    action.safeParse({ operation: "job_list", user: "bob" }).success,
    false,
  );
  assert.equal(
    action.safeParse({ operation: "shell", command: "whoami" }).success,
    false,
  );
  assert.equal(
    action.safeParse({
      operation: "job_update",
      id: randomUUID(),
      status: "invented",
    }).success,
    false,
  );
});
test("conversation survives assistant recreation and run capability expires after turn", async () => {
  let oldCapability = "";
  let assistant: Assistant;
  const agent: Agent = {
    run: async (req) => {
      oldCapability = req.capability;
      await assistant.call(req.capability, { operation: "job_list" });
      return {
        reply: "Saved context",
        history: [
          ...req.history,
          { role: "user", content: req.message },
          { role: "assistant", content: "Saved context" },
        ],
      };
    },
  };
  assistant = new Assistant(db, agent, tools);
  await assistant.respond("alice", "A private sentence");
  await assert.rejects(() =>
    assistant.call(oldCapability, { operation: "job_list" }),
  );
  let previous: unknown[] = [];
  const recreated = new Assistant(
    db,
    {
      run: async (req) => {
        previous = req.history;
        return { reply: "I remember", history: req.history };
      },
    },
    tools,
  );
  await recreated.respond("alice", "Recall");
  assert.equal(previous.length, 2);
  const traces = JSON.stringify(
    (await db.query("SELECT type,data FROM events")).rows,
  );
  assert.ok(!traces.includes("A private sentence"));
  assert.ok(!traces.includes(oldCapability));
  assert.match(traces, /turn.completed/);
});
test("failure revokes capabilities and persists a failure event", async () => {
  const assistant = new Assistant(
    db,
    {
      run: async () => {
        throw new Error("provider-secret");
      },
    },
    tools,
  );
  await assert.rejects(() => assistant.respond("alice", "hello"));
  assert.equal(assistant.capabilities.size, 0);
  assert.ok(
    (await db.query("SELECT id FROM events WHERE type='turn.failed'")).rows
      .length > 0,
  );
});
test("internal routes reject static-token tool execution and identity injection", async () => {
  const assistant = new Assistant(
    db,
    { run: async () => ({ reply: "ok", history: [] }) },
    tools,
  );
  const token = "s".repeat(64);
  const app = server(assistant, token);
  try {
    assert.equal(
      (await app.inject({ url: "/internal/tool-description" })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/internal/tool-description",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/tools",
          headers: { authorization: `Bearer ${token}` },
          payload: { operation: "job_list" },
        })
      ).statusCode,
      400,
    );
    assistant.capabilities.set("valid", {
      user: "alice",
      run: run(),
      expires: Date.now() + 10000,
    });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/tools",
          headers: { authorization: "Bearer valid" },
          payload: { operation: "job_list", user: "bob" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/tools",
          headers: { authorization: "Bearer valid" },
          payload: { operation: "job_list" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
test("private-chat identity allowlist and constant-time token comparison", () => {
  assert.ok(allowedChat(123, "private", new Set(["123"])));
  assert.ok(!allowedChat(123, "group", new Set(["123"])));
  assert.ok(!allowedChat(124, "private", new Set(["123"])));
  assert.ok(authorized("Bearer secret", "secret"));
  assert.ok(!authorized("Bearer other", "secret"));
  assert.ok(!authorized(undefined, "secret"));
});
test("page tools block local, literal IP, non-HTTPS, and credential URLs", () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://admin:pass@example.com",
    "https://host.internal",
  ])
    assert.throws(() => publicHttps(url));
  assert.equal(
    publicHttps("https://example.com/jobs"),
    "https://example.com/jobs",
  );
});
test("serial queue preserves order and recovers after failures", async () => {
  const queue = new SerialQueue();
  const order: number[] = [];
  const first = queue.run("u", async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push(1);
    throw new Error("test");
  });
  const second = queue.run("u", async () => {
    order.push(2);
    return 2;
  });
  await assert.rejects(() => first);
  assert.equal(await second, 2);
  assert.deepEqual(order, [1, 2]);
});

test("approval preview comes from stored action even if model omits it", async () => {
  const role = await save();
  let assistant: Assistant;
  assistant = new Assistant(
    db,
    {
      run: async (req) => {
        await assistant.call(req.capability, {
          operation: "job_delete",
          id: role.id,
        });
        return { reply: "Please review.", history: [] };
      },
    },
    tools,
  );
  const reply = await assistant.respond("alice", "Delete the role");
  assert.match(reply, /Approval required/);
  assert.ok(reply.includes(role.id));
  assert.match(reply, /AI Engineer/);
  assert.match(reply, /\/approve [0-9a-f-]{36}/);
  assert.equal(
    (await db.query("SELECT id FROM jobs WHERE id=$1", [role.id])).rows.length,
    1,
  );
});

test("concurrent approval consumption deletes only once", async () => {
  const role = await save();
  const approval = (await tools.execute("alice", run(), {
    operation: "job_delete",
    id: role.id,
  })) as any;
  const results = await Promise.allSettled([
    tools.decide("alice", approval.id, true),
    tools.decide("alice", approval.id, true),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(results.filter((x) => x.status === "rejected").length, 1);
});
