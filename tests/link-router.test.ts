import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { LinkRouter } from "../src/link-router.js";
import { readDecisionConfig } from "../src/decision-config.js";
import { Study } from "../src/study.js";
import { linkSave } from "../src/study-schema.js";
import { action } from "../src/protocol.js";

const config = readDecisionConfig();

/** Jev's answer shape: a route choice, a topic choice and an unsure probability. */
const answers = (
  route: "study" | "reader" | "both",
  p: number,
  topic: string,
  unsure: number,
) => ({
  route: {
    choice: route,
    probabilities: {
      study: route === "study" ? p : 0.05,
      reader: route === "reader" ? p : 0.05,
      both: route === "both" ? p : 0.05,
    },
  },
  topic: { choice: topic, probabilities: { [topic]: 0.9 } },
  unsure: { noul: unsure },
});
const jev = (payload: unknown) => async () =>
  new Response(
    JSON.stringify({
      answers: payload,
      usage: { cost: 0.00001 },
      model: "typesafe/jev-1.13-20260917",
    }),
  );
const page = (title: string, site: string, description: string) => ({
  get: async (url: string) => ({
    body: `<html><head><title>${title}</title><meta property="og:site_name" content="${site}"><meta property="og:description" content="${description}"></head><body><p>${description}</p></body></html>`,
    finalUrl: url,
  }),
});
const reader = () => {
  const calls: { url: string; key: string }[] = [];
  return {
    calls,
    save: async (_user: string, key: string, url: string) => {
      calls.push({ url, key });
      return { state: "complete", result: { status: "queued" } };
    },
  };
};

async function fixture(
  transport: typeof fetch,
  fetcher: {
    get: (url: string) => Promise<{ body: string; finalUrl: string }>;
  },
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
    router: new LinkRouter("test-key", config, transport),
    reader: readerImpl,
    fetcher: fetcher as any,
  });
  return { pg, db, run, study, reader: readerImpl };
}
const rows = async (db: Database, table: string) =>
  (await db.query(`SELECT * FROM ${table}`)).rows;

test("a confident technical link is saved to the study list, not Reader", async () => {
  const f = await fixture(
    jev(answers("study", 0.91, "agent-platforms", 0.04)),
    page(
      "Designing agent architectures",
      "Example Engineering",
      "A practical thread on planning, tools and memory in production agents.",
    ),
  );
  try {
    const result: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/agent-thread?utm_source=newsletter",
    });
    assert.equal(result.route, "study");
    assert.match(
      result.receipt,
      /Saved to your study list: Designing agent architectures/,
    );
    assert.equal(f.reader.calls.length, 0);
    const saved = await rows(f.db, "study_resources");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].title, "Designing agent architectures");
    assert.equal(saved[0].site, "Example Engineering");
    assert.equal(saved[0].topic, "agent-platforms");
    assert.equal(saved[0].status, "to_study");
    assert.match(saved[0].reason, /Jev chose study at 0.91/);
    assert.equal(Number(saved[0].confidence), 0.91);
    const routes = await rows(f.db, "link_saves");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].route, "study");
    assert.equal(routes[0].study_id, saved[0].id);
  } finally {
    await f.pg.close();
  }
});

test("a confident general-interest article goes to Reader for offline reading only", async () => {
  const f = await fixture(
    jev(answers("reader", 0.88, "other", 0.08)),
    page(
      "The quiet economics of a small city",
      "Example Magazine",
      "A long essay on how a city's economy changed over a decade.",
    ),
  );
  try {
    const result: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/essay",
    });
    assert.equal(result.route, "reader");
    assert.match(result.receipt, /Saved to Reader for offline reading/);
    assert.equal((await rows(f.db, "study_resources")).length, 0);
    assert.equal(f.reader.calls.length, 1);
    assert.equal(f.reader.calls[0]!.url, "https://example.com/essay");
    const routes = await rows(f.db, "link_saves");
    assert.equal(routes[0].route, "reader");
    assert.equal(routes[0].reader_state, "complete");
  } finally {
    await f.pg.close();
  }
});

test("an explicit owner cue wins over what the page looks like", async () => {
  const seen: any[] = [];
  const capture = (payload: unknown) => async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        answers: payload,
        usage: { cost: 0.00001 },
        model: "typesafe/jev-1.13-20260917",
      }),
    );
  };
  // A tutorial the owner wants offline: Jev answers reader, and that is obeyed.
  const offline = await fixture(
    capture(answers("reader", 0.9, "developer-tools", 0.05)),
    page("A complete tutorial", "Example Dev", "Step by step tutorial."),
  );
  try {
    await offline.db.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        "owner",
        offline.run,
        "save this for offline reading https://example.com/tutorial",
      ],
    );
    const result: any = await offline.study.call("owner", offline.run, {
      operation: "link_save",
      url: "https://example.com/tutorial",
    });
    assert.equal(result.route, "reader");
    assert.equal((await rows(offline.db, "study_resources")).length, 0);
    assert.match(seen[0].state.owner_message, /for offline reading/);
  } finally {
    await offline.pg.close();
  }
  // A general essay the owner wants for AI learning: Jev answers study, and that is obeyed.
  const study = await fixture(
    capture(answers("study", 0.86, "applied-ai-engineering", 0.05)),
    page("An essay about models", "Example Magazine", "An essay."),
  );
  try {
    await study.db.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        "owner",
        study.run,
        "save this for AI learning https://example.com/essay",
      ],
    );
    const result: any = await study.study.call("owner", study.run, {
      operation: "link_save",
      url: "https://example.com/essay",
    });
    assert.equal(result.route, "study");
    assert.equal((await rows(study.db, "study_resources")).length, 1);
    assert.match(seen[1].state.owner_message, /for AI learning/);
  } finally {
    await study.pg.close();
  }
});

test("an unsure answer writes to neither store and offers three tap options", async () => {
  for (const [name, payload] of [
    ["Jev says unsure", answers("study", 0.8, "agent-platforms", 0.8)],
    [
      "below the confidence threshold",
      answers("study", 0.55, "agent-platforms", 0.1),
    ],
  ] as const) {
    const f = await fixture(
      jev(payload),
      page("Ambiguous page", "Example", "Something."),
    );
    try {
      const result: any = await f.study.call("owner", f.run, {
        operation: "link_save",
        url: "https://example.com/ambiguous",
      });
      assert.equal(result.route, "unsure", name);
      assert.deepEqual(result.options, ["study", "reader", "both"], name);
      assert.equal((await rows(f.db, "study_resources")).length, 0, name);
      assert.equal(f.reader.calls.length, 0, name);
      const routes = await rows(f.db, "link_saves");
      assert.equal(routes[0].route, "unsure", name);
      assert.equal(routes[0].telegram_message_id, null, name);
    } finally {
      await f.pg.close();
    }
  }
});

test("a malformed, timed-out, rate-limited or failed Jev answer is unsure, never Reader", async () => {
  const cases: [string, typeof fetch][] = [
    ["malformed", jev({ route: { choice: "study" } })],
    [
      "timeout",
      (async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }) as unknown as typeof fetch,
    ],
    [
      "429",
      (async () =>
        new Response("{}", { status: 429 })) as unknown as typeof fetch,
    ],
    [
      "500",
      (async () =>
        new Response("{}", { status: 500 })) as unknown as typeof fetch,
    ],
  ];
  for (const [name, transport] of cases) {
    const f = await fixture(transport, page("A page", "Example", "Text."));
    try {
      const result: any = await f.study.call("owner", f.run, {
        operation: "link_save",
        url: "https://example.com/page",
      });
      assert.equal(result.route, "unsure", name);
      assert.equal((await rows(f.db, "study_resources")).length, 0, name);
      assert.equal(f.reader.calls.length, 0, name);
    } finally {
      await f.pg.close();
    }
  }
});

test("the host fills title and site, and no tool accepts a title or confidence", async () => {
  const f = await fixture(
    jev(answers("study", 0.9, "developer-tools", 0.05)),
    page("Real page title", "Real Site", "Real description."),
  );
  try {
    const result: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/real",
    });
    assert.equal(result.title, "Real page title");
    assert.equal(result.site, "Real Site");
    assert.throws(() =>
      action.parse({
        operation: "link_save",
        url: "https://example.com/real",
        title: "Invented",
      }),
    );
    assert.throws(() =>
      action.parse({
        operation: "link_save",
        url: "https://example.com/real",
        confidence: 0.99,
      }),
    );
    assert.throws(() =>
      linkSave.parse({
        operation: "link_save",
        url: "https://example.com/real",
        topic: "agent-platforms",
      }),
    );
  } finally {
    await f.pg.close();
  }
});

test("duplicate URLs are detected across tracking parameters, http and x/twitter hosts", async () => {
  const f = await fixture(
    jev(answers("study", 0.9, "agent-platforms", 0.05)),
    page("One thread", "X", "A thread."),
  );
  try {
    const first: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://x.com/owner/status/123?utm_source=a",
    });
    assert.equal(first.duplicate, undefined);
    for (const url of [
      "http://twitter.com/owner/status/123",
      "https://www.x.com/owner/status/123/?utm_medium=b",
    ]) {
      const again: any = await f.study.call("owner", f.run, {
        operation: "link_save",
        url,
      });
      assert.equal(again.duplicate, true, url);
      assert.match(again.receipt, /Already on your study list/);
    }
    assert.equal((await rows(f.db, "study_resources")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("a repeat Reader save is reported, not written to Reader twice", async () => {
  const f = await fixture(
    jev(answers("reader", 0.9, "other", 0.05)),
    page("A long essay", "Example Magazine", "An essay."),
  );
  try {
    const first: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/essay",
    });
    assert.equal(first.route, "reader");
    assert.equal(f.reader.calls.length, 1);
    const again: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/essay?utm_source=repeat",
    });
    assert.equal(again.route, "reader");
    assert.equal(again.duplicate, true);
    assert.match(again.receipt, /Already saved to Reader for offline reading/);
    assert.equal(f.reader.calls.length, 1);
    assert.equal((await rows(f.db, "link_saves")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("two concurrent saves of one link use one Reader request key", async () => {
  const seen = new Map<string, unknown>();
  const writes: string[] = [];
  const dedupe = {
    writes,
    save: async (_user: string, key: string) => {
      if (seen.has(key)) return seen.get(key);
      writes.push(key);
      const result = { state: "complete", result: { status: "queued" } };
      seen.set(key, result);
      return result;
    },
  };
  const f = await fixture(
    jev(answers("reader", 0.9, "other", 0.05)),
    page("A long essay", "Example Magazine", "An essay."),
    dedupe,
  );
  try {
    const [a, b]: any[] = await Promise.all([
      f.study.call("owner", f.run, {
        operation: "link_save",
        url: "https://example.com/essay",
      }),
      f.study.call("owner", f.run, {
        operation: "link_save",
        url: "https://example.com/essay",
      }),
    ]);
    assert.equal(a.route, "reader");
    assert.equal(b.route, "reader");
    // The MCP replay path sees one key, so the article is written once.
    assert.equal(writes.length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an explicit cue still wins when the link is already on the study list", async () => {
  let answer = answers("study", 0.9, "agent-platforms", 0.05);
  const transport = (async () =>
    new Response(
      JSON.stringify({
        answers: answer,
        usage: { cost: 0.00001 },
        model: "typesafe/jev-1.13-20260917",
      }),
    )) as unknown as typeof fetch;
  const f = await fixture(
    transport,
    page("A tutorial", "Example Dev", "A tutorial."),
  );
  try {
    const first: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/tutorial",
    });
    assert.equal(first.route, "study");
    assert.equal((await rows(f.db, "study_resources")).length, 1);
    // The owner now asks for offline reading; Jev answers reader and that is obeyed.
    await f.db.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        "owner",
        f.run,
        "save this for offline reading https://example.com/tutorial",
      ],
    );
    answer = answers("reader", 0.9, "developer-tools", 0.05);
    const saved: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/tutorial",
    });
    assert.equal(saved.route, "reader");
    assert.equal(f.reader.calls.length, 1);
    assert.match(saved.receipt, /Saved to Reader for offline reading/);
    assert.match(saved.receipt, /still on your study list/);
    assert.equal((await rows(f.db, "study_resources")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an unsure answer for a link already saved reports it instead of asking", async () => {
  let answer = answers("study", 0.9, "agent-platforms", 0.05);
  const transport = (async () =>
    new Response(
      JSON.stringify({
        answers: answer,
        usage: { cost: 0.00001 },
        model: "typesafe/jev-1.13-20260917",
      }),
    )) as unknown as typeof fetch;
  const f = await fixture(transport, page("A thread", "X", "A thread."));
  try {
    await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/thread",
    });
    answer = answers("study", 0.8, "agent-platforms", 0.8);
    const result: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://example.com/thread",
    });
    assert.equal(result.route, "study");
    assert.equal(result.duplicate, true);
    assert.equal(result.options, undefined);
    assert.match(result.receipt, /Already on your study list/);
    assert.equal((await rows(f.db, "link_saves")).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("an X post's own text is read for classification", async () => {
  const seen: any[] = [];
  const transport = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        answers: answers("study", 0.9, "agent-platforms", 0.05),
        usage: { cost: 0.00001 },
        model: "typesafe/jev-1.13-20260917",
      }),
    );
  }) as unknown as typeof fetch;
  const fetcher = {
    get: async (url: string) => {
      if (url.startsWith("https://publish.twitter.com/oembed"))
        return {
          body: JSON.stringify({
            author_name: "Ada",
            html: '<blockquote><p lang="en">A thread on agent architectures: planning, tools and memory.</p>&mdash; Ada (@ada) <a href="https://x.com/ada/status/123">Nov 5</a></blockquote>',
          }),
          finalUrl: url,
        };
      return {
        body: '<html><head><title>X</title><meta property="og:description" content="JavaScript is not available."></head><body></body></html>',
        finalUrl: url,
      };
    },
  };
  const f = await fixture(transport, fetcher as any);
  try {
    const result: any = await f.study.call("owner", f.run, {
      operation: "link_save",
      url: "https://x.com/ada/status/123",
    });
    assert.equal(result.route, "study");
    assert.match(result.title, /A thread on agent architectures/);
    assert.match(seen[0].state.link.post_text, /planning, tools and memory/);
    assert.equal(seen[0].state.link.kind, "post");
  } finally {
    await f.pg.close();
  }
});
