import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { Study } from "../src/study.js";
import { JobTools } from "../src/tools.js";
import { LinkRouter } from "../src/link-router.js";
import { readDecisionConfig } from "../src/decision-config.js";
import { ToolValidationError } from "../src/tool-errors.js";

const config = readDecisionConfig();
const answers = (route: "study" | "reader" | "both", p: number) => ({
  route: {
    choice: route,
    probabilities: {
      study: route === "study" ? p : 0.05,
      reader: route === "reader" ? p : 0.05,
      both: route === "both" ? p : 0.05,
    },
  },
  topic: {
    choice: "agent-platforms",
    probabilities: { "agent-platforms": 0.9 },
  },
  unsure: { noul: 0.05 },
});
const jev =
  (route: "study" | "reader" | "both", p = 0.9) =>
  async () =>
    new Response(
      JSON.stringify({
        answers: answers(route, p),
        usage: { cost: 0.00001 },
        model: "typesafe/jev-1.13-20260917",
      }),
    );
const page = {
  get: async (url: string) => ({
    body: `<html><head><title>Saved page</title><meta property="og:site_name" content="Example"></head><body>Text</body></html>`,
    finalUrl: url,
  }),
};
const reader = (
  result: any = { state: "complete", result: { status: "queued" } },
) => {
  const calls: { url: string; key: string }[] = [];
  return {
    calls,
    save: async (_user: string, key: string, url: string) => {
      calls.push({ url, key });
      if (result instanceof Error) throw result;
      return result;
    },
  };
};

async function fixture(
  route: "study" | "reader" | "both" = "study",
  readerImpl = reader(),
) {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  await ensureUser(db, "other");
  const run = randomUUID();
  await db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,$2)", [
    run,
    "owner",
  ]);
  const study = new Study(db, {
    router: new LinkRouter("test-key", config, jev(route)),
    reader: readerImpl,
    fetcher: page as any,
  });
  return { pg, db, run, study, reader: readerImpl };
}

async function addStudy(
  db: Database,
  user: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const id = randomUUID();
  const row = {
    id,
    user_id: user,
    canonical_url: `example.com/${id}`,
    url: `https://example.com/${id}`,
    title: `Title ${id.slice(0, 4)}`,
    site: "Example",
    topic: "agent-platforms",
    tags: [] as string[],
    notes: null,
    status: "to_study",
    reason: "Jev chose study at 0.90.",
    confidence: 0.9,
    ...overrides,
  };
  await db.query(
    `INSERT INTO study_resources(id,user_id,canonical_url,url,title,site,topic,tags,notes,status,reason,confidence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.id,
      row.user_id,
      row.canonical_url,
      row.url,
      row.title,
      row.site,
      row.topic,
      row.tags,
      row.notes,
      row.status,
      row.reason,
      row.confidence,
    ],
  );
  return row;
}

async function addLinkSave(
  db: Database,
  user: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const id = randomUUID();
  const row = {
    id,
    user_id: user,
    canonical_url: `example.com/${id}`,
    page_url: `https://example.com/${id}`,
    title: `Link ${id.slice(0, 4)}`,
    site: "Example",
    topic: "agent-platforms",
    route: "study",
    reason: "Jev chose study at 0.90.",
    confidence: 0.9,
    study_id: null,
    reader_request_key: null,
    reader_state: null,
    run_id: null,
    telegram_message_id: null,
    ...overrides,
  };
  await db.query(
    `INSERT INTO link_saves(id,user_id,canonical_url,page_url,title,site,topic,route,reason,confidence,study_id,reader_request_key,reader_state,run_id,telegram_message_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.id,
      row.user_id,
      row.canonical_url,
      row.page_url,
      row.title,
      row.site,
      row.topic,
      row.route,
      row.reason,
      row.confidence,
      row.study_id,
      row.reader_request_key,
      row.reader_state,
      row.run_id,
      row.telegram_message_id,
    ],
  );
  return row;
}

test("study entries add, list, filter, update and remove, scoped to their owner", async () => {
  const f = await fixture();
  try {
    const a = await addStudy(f.db, "owner", {
      title: "Agent architectures",
      topic: "agent-platforms",
      tags: ["agents", "architecture"],
    });
    const b = await addStudy(f.db, "owner", {
      title: "Voice latency",
      topic: "voice-conversational-ai",
      status: "in_progress",
      tags: ["voice"],
    });
    const c = await addStudy(f.db, "owner", {
      title: "Old paper",
      topic: "applied-ai-engineering",
      status: "done",
    });
    await addStudy(f.db, "other", { title: "Not mine" });

    const all: any = await f.study.call("owner", f.run, {
      operation: "study_list",
    });
    assert.equal(all.count, 3);
    assert.match(all.text, /Agent architectures/);
    assert.doesNotMatch(all.text, /Not mine/);
    assert.equal(all.items[0].status, "to_study");

    const byTopic: any = await f.study.call("owner", f.run, {
      operation: "study_list",
      topic: "voice-conversational-ai",
    });
    assert.deepEqual(
      byTopic.items.map((i: any) => i.id),
      [b.id],
    );
    const byTag: any = await f.study.call("owner", f.run, {
      operation: "study_list",
      tag: "agents",
    });
    assert.deepEqual(
      byTag.items.map((i: any) => i.id),
      [a.id],
    );
    const byStatus: any = await f.study.call("owner", f.run, {
      operation: "study_list",
      status: "done",
    });
    assert.deepEqual(
      byStatus.items.map((i: any) => i.id),
      [c.id],
    );
    const limited: any = await f.study.call("owner", f.run, {
      operation: "study_list",
      limit: 1,
    });
    assert.equal(limited.count, 1);

    const updated: any = await f.study.call("owner", f.run, {
      operation: "study_update",
      id: a.id,
      status: "in_progress",
      notes: "Read the planning section",
      tags: ["agents"],
      topic: "developer-tools",
    });
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.topic, "developer-tools");
    assert.deepEqual(updated.tags, ["agents"]);
    assert.match(updated.receipt, /Updated Agent architectures/);
    const cleared: any = await f.study.call("owner", f.run, {
      operation: "study_update",
      id: a.id,
      notes: null,
      tags: null,
    });
    assert.equal(cleared.notes, null);
    assert.deepEqual(cleared.tags, []);

    // Another owner sees nothing and cannot change or remove it.
    const otherList: any = await f.study.call("other", f.run, {
      operation: "study_list",
    });
    assert.equal(otherList.count, 1);
    await assert.rejects(
      f.study.call("other", f.run, {
        operation: "study_update",
        id: a.id,
        status: "done",
      }),
      /not found for this owner/,
    );
    await assert.rejects(
      f.study.call("other", f.run, { operation: "study_remove", id: a.id }),
      /not found for this owner/,
    );

    const removed: any = await f.study.call("owner", f.run, {
      operation: "study_remove",
      id: b.id,
    });
    assert.match(removed.receipt, /Removed Voice latency/);
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources WHERE id=$1", [b.id]))
        .rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("link_move moves both ways and removes only the study entry", async () => {
  const f = await fixture();
  try {
    const study = await addStudy(f.db, "owner", {
      title: "Move me",
      canonical_url: "example.com/move",
      url: "https://example.com/move",
    });
    await addLinkSave(f.db, "owner", {
      canonical_url: "example.com/move",
      page_url: "https://example.com/move",
      title: "Move me",
      study_id: study.id,
    });
    const moved: any = await f.study.call("owner", f.run, {
      operation: "link_move",
      id: study.id,
      to: "reader",
    });
    assert.equal(moved.route, "reader");
    assert.match(moved.receipt, /Moved Move me to Reader/);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(
      (
        await f.db.query("SELECT 1 FROM study_resources WHERE id=$1", [
          study.id,
        ])
      ).rows.length,
      0,
    );
    const routes = (
      await f.db.query(
        "SELECT route,reader_state FROM link_saves WHERE canonical_url=$1 ORDER BY created_at",
        ["example.com/move"],
      )
    ).rows;
    assert.deepEqual(
      routes.map((r) => [r.route, r.reader_state]),
      [
        ["study", null],
        ["reader", "complete"],
      ],
    );

    // A Reader-only save can be corrected to the study list; Reader keeps its copy.
    const readerOnly = await addLinkSave(f.db, "owner", {
      canonical_url: "example.com/reader-only",
      page_url: "https://example.com/reader-only",
      title: "Reader only",
      route: "reader",
      reader_state: "complete",
    });
    const back: any = await f.study.call("owner", f.run, {
      operation: "link_move",
      url: "https://example.com/reader-only",
      to: "study",
    });
    assert.equal(back.route, "study");
    assert.match(back.receipt, /Reader keeps its own copy/);
    assert.equal(f.reader.calls.length, 1);
    const added = (
      await f.db.query("SELECT * FROM study_resources WHERE canonical_url=$1", [
        readerOnly.canonical_url,
      ])
    ).rows[0];
    assert.equal(added.title, "Reader only");

    // Removing from the study list leaves Reader untouched.
    const removed: any = await f.study.call("owner", f.run, {
      operation: "link_move",
      id: added.id,
      to: "remove",
    });
    assert.match(removed.receipt, /Reader is unchanged/);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(
      (
        await f.db.query(
          "SELECT 1 FROM link_saves WHERE canonical_url=$1 AND route='reader'",
          [readerOnly.canonical_url],
        )
      ).rows.length,
      1,
    );
    // An unknown URL is refused rather than guessed.
    await assert.rejects(
      f.study.call("owner", f.run, {
        operation: "link_move",
        url: "https://example.com/never-saved",
        to: "study",
      }),
      /No saved link matches/,
    );
  } finally {
    await f.pg.close();
  }
});

test("a Reader save that is pending, refused or unconfirmed keeps the study entry", async () => {
  for (const [name, result, wording] of [
    ["pending", { state: "pending" }, /not confirmed/],
    ["rejected", { state: "rejected" }, /refused/],
    ["timeout", new Error("Reader timed out"), /Could not confirm/],
  ] as const) {
    const f = await fixture("study", reader(result as any));
    try {
      const study = await addStudy(f.db, "owner", {
        title: "Keep me",
        canonical_url: "example.com/keep",
        url: "https://example.com/keep",
      });
      await addLinkSave(f.db, "owner", {
        canonical_url: "example.com/keep",
        page_url: "https://example.com/keep",
        title: "Keep me",
        study_id: study.id,
      });
      const moved: any = await f.study.call("owner", f.run, {
        operation: "link_move",
        id: study.id,
        to: "reader",
      });
      assert.match(moved.receipt, wording, name);
      assert.equal(
        (
          await f.db.query("SELECT 1 FROM study_resources WHERE id=$1", [
            study.id,
          ])
        ).rows.length,
        1,
        name,
      );
    } finally {
      await f.pg.close();
    }
  }
});

test("a confident Reader save that is not confirmed is never reported as saved", async () => {
  for (const [name, result, wording] of [
    ["pending", { state: "pending" }, /not confirmed/],
    ["rejected", { state: "rejected" }, /refused/],
    ["timeout", new Error("Reader timed out"), /Could not confirm/],
    [
      "refused before dispatch",
      new ToolValidationError("A previous write is uncertain"),
      /did not submit/,
    ],
  ] as const) {
    const f = await fixture("reader", reader(result as any));
    try {
      const saved: any = await f.study.call("owner", f.run, {
        operation: "link_save",
        url: "https://example.com/article",
      });
      assert.equal(saved.route, "reader", name);
      assert.match(saved.receipt, wording, name);
      assert.doesNotMatch(saved.receipt, /Saved to Reader/, name);
      assert.equal(
        (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
        0,
      );
    } finally {
      await f.pg.close();
    }
  }
});

test("an unsure tap writes once, and only for its owner and its own message", async () => {
  const f = await fixture();
  try {
    const prompt = await addLinkSave(f.db, "owner", {
      route: "unsure",
      title: "Tap me",
      canonical_url: "example.com/tap",
      page_url: "https://example.com/tap",
      telegram_message_id: 42,
      run_id: f.run,
    });
    // A foreign user and a different message cannot claim it.
    const foreign = await f.study.choose("other", prompt.id, "study", 42);
    assert.equal(foreign.status, "unavailable");
    const wrongMessage = await f.study.choose("owner", prompt.id, "study", 43);
    assert.equal(wrongMessage.status, "unavailable");
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      0,
    );

    const first = await f.study.choose("owner", prompt.id, "study", 42);
    assert.equal(first.status, "saved");
    assert.match(first.text, /Saved to your study list: Tap me/);
    const second = await f.study.choose("owner", prompt.id, "reader", 42);
    assert.equal(second.status, "unavailable");
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      1,
    );
    assert.equal(f.reader.calls.length, 0);
    const row = (
      await f.db.query("SELECT route,claimed_at FROM link_saves WHERE id=$1", [
        prompt.id,
      ])
    ).rows[0];
    assert.equal(row.route, "study");
    assert.ok(row.claimed_at);
  } finally {
    await f.pg.close();
  }
});

test("the study tools dispatch through the owner-scoped tool surface", async () => {
  const f = await fixture();
  try {
    await addStudy(f.db, "owner", { title: "Dispatched" });
    const tools = new JobTools(
      f.db,
      { call: async () => ({}) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.study,
    );
    const listed: any = await tools.execute("owner", f.run, {
      operation: "study_list",
    });
    assert.equal(listed.count, 1);
    assert.match(listed.text, /Dispatched/);
    // Another owner's run cannot read it through the same surface.
    const other: any = await tools.execute("other", f.run, {
      operation: "study_list",
    });
    assert.equal(other.count, 0);
  } finally {
    await f.pg.close();
  }
});

test("an unsure tap for Reader writes only Reader, and a repeat does not write again", async () => {
  const f = await fixture();
  try {
    const prompt = await addLinkSave(f.db, "owner", {
      route: "unsure",
      title: "Read later",
      canonical_url: "example.com/read",
      page_url: "https://example.com/read",
      telegram_message_id: 7,
      run_id: f.run,
    });
    const first = await f.study.choose("owner", prompt.id, "reader", 7);
    assert.equal(first.status, "saved");
    assert.match(first.text, /Saved to Reader for offline reading/);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      0,
    );
    const repeat = await f.study.choose("owner", prompt.id, "reader", 7);
    assert.equal(repeat.status, "unavailable");
    assert.equal(f.reader.calls.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("a failed Reader tap keeps its buttons and a retry replays the same key", async () => {
  let fail = true;
  const calls: string[] = [];
  const flaky = {
    save: async (_user: string, key: string) => {
      calls.push(key);
      if (fail) throw new Error("Reader timed out");
      return { state: "complete", result: { status: "queued" } };
    },
  };
  const f = await fixture("study", flaky);
  try {
    const prompt = await addLinkSave(f.db, "owner", {
      route: "unsure",
      title: "Retry me",
      canonical_url: "example.com/retry",
      page_url: "https://example.com/retry",
      telegram_message_id: 9,
      run_id: f.run,
    });
    const first = await f.study.choose("owner", prompt.id, "reader", 9);
    assert.equal(first.status, "unfinished");
    assert.match(first.text, /Could not confirm/);
    const row = (
      await f.db.query(
        "SELECT route,claimed_at,reader_state FROM link_saves WHERE id=$1",
        [prompt.id],
      )
    ).rows[0];
    assert.equal(row.route, "unsure");
    assert.equal(row.claimed_at, null);
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      0,
    );

    fail = false;
    const second = await f.study.choose("owner", prompt.id, "reader", 9);
    assert.equal(second.status, "saved");
    assert.match(second.text, /Saved to Reader for offline reading/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], calls[1]);
  } finally {
    await f.pg.close();
  }
});

test("study_list counts every match and says how many more are hidden", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 25; i++)
      await addStudy(f.db, "owner", { title: `Entry ${i}` });
    const page: any = await f.study.call("owner", f.run, {
      operation: "study_list",
    });
    assert.equal(page.count, 20);
    assert.equal(page.total, 25);
    assert.match(page.text, /Study list: 25 items/);
    assert.match(page.text, /and 5 more/);
  } finally {
    await f.pg.close();
  }
});
