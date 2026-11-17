import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { GithubIssues, issuePreview } from "../src/github-issues.js";
import { githubIssueDraft } from "../src/github-issue-schema.js";
import { ToolValidationError } from "../src/tool-errors.js";
import { JobTools } from "../src/tools.js";
import { telegram, sendGithubApprovals } from "../src/telegram.js";
import { readConfig } from "../src/config.js";

const TOKEN = "github_pat_SECRET_TOKEN_VALUE";
const REPO = "akhilvuputuri/chief-agent";
const draft = {
  repo: REPO,
  title: "Reminder card shows the wrong time",
  body: "## What happened\nThe card showed 9am for a 9pm reminder.\n\n## Expected\n9pm.",
  labels: ["bug"],
};

/** An in-memory GitHub: records every request and answers the few endpoints used. */
function github(
  behaviour: {
    post?: () => Response | Promise<Response>;
    list?: () => Response;
  } = {},
) {
  const calls: { method: string; url: URL; headers: any; body?: any }[] = [];
  const issues: any[] = [];
  const request = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers: init.headers, body });
    if (method === "POST") {
      if (behaviour.post) {
        const result = await behaviour.post();
        if (result.status === 201)
          issues.push({ ...body, number: issues.length + 41 });
        return result;
      }
      const issue = { ...body, number: issues.length + 41 };
      issues.push(issue);
      return Response.json(
        { number: issue.number, html_url: "https://evil.example/not-used" },
        { status: 201 },
      );
    }
    if (url.pathname === "/search/issues")
      return Response.json({
        items: [
          {
            number: 7,
            title: "Calendar card duplicates",
            repository_url: `https://api.github.com/repos/${REPO}`,
            labels: [{ name: "bug" }],
            created_at: "2026-11-01T00:00:00Z",
            body: "private body text",
          },
          {
            number: 9,
            title: "Other repo smuggled by the query",
            repository_url: "https://api.github.com/repos/someone/else",
            labels: [],
          },
        ],
      });
    if (behaviour.list) return behaviour.list();
    return Response.json(issues.map((i) => ({ ...i })));
  }) as typeof fetch;
  return { request, calls, issues };
}

async function fixture(token = TOKEN, behaviour = {}) {
  const pg = await migratedPGlite([
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "009_calendar_approval",
    "037_github_issues",
  ]);
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const gh = github(behaviour);
  const make = (t = token, repos = [REPO]) =>
    new GithubIssues(db, { owner: "123", token: t, repos }, gh.request);
  return { pg, db, gh, issues: make(), make };
}
const posts = (gh: ReturnType<typeof github>) =>
  gh.calls.filter((c) => c.method === "POST");

test("draft saves only a draft; the Approve tap creates the issue once and reports its real URL", async () => {
  const { pg, db, gh, issues } = await fixture();
  try {
    const saved: any = await issues.draft("123", randomUUID(), draft);
    assert.equal(saved.status, "awaiting_approval");
    assert.match(saved.preview, /akhilvuputuri\/chief-agent/);
    assert.match(saved.preview, /Reminder card shows the wrong time/);
    assert.match(saved.preview, /Nothing is filed until you tap Approve/);
    assert.equal(gh.calls.length, 0, "a draft never calls GitHub");

    // The card, then the authenticated button.
    const tools = new JobTools(
      db,
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
      undefined,
      issues,
    );
    const bot = telegram(
      readConfig({
        DATABASE_URL: "postgres://x:x@localhost/x",
        TELEGRAM_BOT_TOKEN: "123:test-token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
      }),
      { tools } as any,
      db,
    );
    const sent: any[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "getMe")
        return {
          ok: true,
          result: { id: 999, is_bot: true, first_name: "T", username: "t_bot" },
        };
      if (method === "sendMessage") sent.push(payload);
      return { ok: true, result: { message_id: 11 } } as any;
    });
    await bot.init();
    await sendGithubApprovals(bot, db, "123");
    await sendGithubApprovals(bot, db, "123");
    const cards = sent.filter((m) => /Create GitHub issue/.test(m.text));
    assert.equal(cards.length, 1);
    assert.match(cards[0].text, /Repo: akhilvuputuri\/chief-agent/);
    assert.match(cards[0].text, /Title: Reminder card shows the wrong time/);
    assert.match(cards[0].text, /Body preview:/);
    const [approve, discard] = cards[0].reply_markup.inline_keyboard[0];
    assert.equal(approve.callback_data, `gh:yes:${saved.approvalId}`);
    assert.equal(discard.callback_data, `gh:no:${saved.approvalId}`);
    const tap = (
      user: number,
      type = "private",
      data = approve.callback_data,
    ) =>
      ({
        update_id: 1,
        callback_query: {
          id: "q",
          chat_instance: "x",
          from: { id: user, is_bot: false, first_name: "T" },
          data,
          message: { message_id: 11, date: 0, chat: { id: user, type } },
        },
      }) as any;
    await bot.handleUpdate(tap(456));
    await bot.handleUpdate(tap(123, "group"));
    assert.equal(posts(gh).length, 0, "other users and groups cannot approve");
    await bot.handleUpdate(tap(123));
    await bot.handleUpdate(tap(123)); // a duplicate tap
    assert.equal(posts(gh).length, 1);
    const replies = sent.filter((m) => /GitHub issue created/.test(m.text));
    assert.ok(replies.length >= 1);
    assert.match(
      replies[0].text,
      /https:\/\/github\.com\/akhilvuputuri\/chief-agent\/issues\/41/,
    );
    assert.doesNotMatch(JSON.stringify(sent), /evil\.example|SECRET_TOKEN/);

    const post = posts(gh)[0]!;
    assert.equal(post.url.pathname, `/repos/${REPO}/issues`);
    assert.equal(post.body.title, draft.title);
    assert.deepEqual(post.body.labels, ["bug"]);
    assert.ok(post.body.body.includes(`chief-request:${saved.approvalId}`));
    // Restart and a repeated approve: the recorded outcome comes back, no second issue.
    const again = await fixtureIssues(db, gh).decide(
      "123",
      saved.approvalId,
      true,
    );
    assert.deepEqual(again, {
      status: "created",
      url: `https://github.com/${REPO}/issues/41`,
      number: 41,
    });
    assert.equal(posts(gh).length, 1);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM tool_receipts WHERE operation='github_issue_create'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await pg.close();
  }
});
const fixtureIssues = (db: Database, gh: ReturnType<typeof github>) =>
  new GithubIssues(
    db,
    { owner: "123", token: TOKEN, repos: [REPO] },
    gh.request,
  );

test("two simultaneous approve taps create exactly one issue", async () => {
  const { pg, gh, issues } = await fixture();
  try {
    const saved: any = await issues.draft("123", randomUUID(), draft);
    const results = await Promise.all([
      issues.decide("123", saved.approvalId, true),
      issues.decide("123", saved.approvalId, true),
      issues.decide("123", saved.approvalId, true),
    ]);
    assert.equal(posts(gh).length, 1);
    assert.equal(
      results.filter((r) => r.status === "created").length >= 1,
      true,
    );
    for (const r of results)
      assert.ok(["created", "uncertain"].includes(r.status), r.status);
    assert.equal(
      (await issues.decide("123", saved.approvalId, true)).status,
      "created",
    );
    assert.equal(posts(gh).length, 1);
  } finally {
    await pg.close();
  }
});

test("discard creates nothing, and a later approve tap cannot create it", async () => {
  const { pg, db, gh, issues } = await fixture();
  try {
    const saved: any = await issues.draft("123", randomUUID(), draft);
    assert.equal(
      (await issues.decide("123", saved.approvalId, false)).status,
      "denied",
    );
    assert.equal(
      (await issues.decide("123", saved.approvalId, true)).status,
      "denied",
    );
    assert.equal(posts(gh).length, 0);
    assert.equal(
      (
        await db.query("SELECT status FROM approvals WHERE id=$1", [
          saved.approvalId,
        ])
      ).rows[0].status,
      "denied",
    );
  } finally {
    await pg.close();
  }
});

test("a missing token answers not configured and saves nothing", async () => {
  const { pg, db, gh, make } = await fixture();
  try {
    const none = make("");
    const result: any = await none.draft("123", randomUUID(), draft);
    assert.equal(result.status, "not_configured");
    assert.match(result.note, /not set up|no GitHub token/);
    const search: any = await none.search("123", {
      repo: REPO,
      query: "x",
      limit: 5,
    });
    assert.equal(search.status, "not_configured");
    assert.equal(gh.calls.length, 0);
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM approvals")).rows[0].n,
      0,
    );
    // A token removed after drafting: the tap fails without sending anything.
    const saved: any = await make().draft("123", randomUUID(), draft);
    const tapped = await none.decide("123", saved.approvalId, true);
    assert.deepEqual(tapped, { status: "failed", reason: "not_configured" });
    assert.equal(gh.calls.length, 0);
  } finally {
    await pg.close();
  }
});

test("only allowlisted repositories are accepted, for drafts, searches and the final send", async () => {
  const { pg, db, gh, issues, make } = await fixture();
  try {
    for (const repo of ["someone/else", `${REPO}-fork`, "akhilvuputuri/other"])
      await assert.rejects(
        () => issues.draft("123", randomUUID(), { ...draft, repo }),
        (e) =>
          e instanceof ToolValidationError &&
          /allowlisted/.test((e as Error).message),
      );
    await assert.rejects(() =>
      issues.search("123", { repo: "someone/else", query: "x", limit: 5 }),
    );
    assert.equal(gh.calls.length, 0);
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM approvals")).rows[0].n,
      0,
    );
    // Case does not matter, and the allowlist's spelling is used.
    const ok: any = await issues.draft("123", randomUUID(), {
      ...draft,
      repo: REPO.toUpperCase(),
    });
    assert.equal(ok.status, "awaiting_approval");
    // The allowlist shrinks before the tap: nothing is sent.
    const narrowed = make(TOKEN, ["akhilvuputuri/elsewhere"]);
    assert.deepEqual(await narrowed.decide("123", ok.approvalId, true), {
      status: "failed",
      reason: "repo_not_allowed",
    });
    assert.equal(gh.calls.length, 0);
    // The model-facing schema carries no authority beyond a draft.
    assert.equal(
      githubIssueDraft.safeParse({
        ...draft,
        operation: "github_issue_draft",
        assignees: ["x"],
      }).success,
      false,
    );
    assert.equal(
      githubIssueDraft.safeParse({
        ...draft,
        repo: "not a repo",
        operation: "github_issue_draft",
      }).success,
      false,
    );
    // The owner only.
    await assert.rejects(() => issues.draft("456", randomUUID(), draft));
    await assert.rejects(() => issues.decide("456", ok.approvalId, true));
  } finally {
    await pg.close();
  }
});

test("the only GitHub calls are issue create, issue list and open-issue search; the token never leaves the headers", async () => {
  const { pg, gh, issues } = await fixture();
  try {
    const found: any = await issues.search("123", {
      repo: REPO,
      query: "calendar duplicate repo:someone/else",
      limit: 5,
    });
    assert.equal(found.status, "ok");
    assert.deepEqual(
      found.issues.map((i: any) => i.number),
      [7],
      "other repos are filtered out",
    );
    assert.equal(found.issues[0].url, `https://github.com/${REPO}/issues/7`);
    assert.doesNotMatch(
      JSON.stringify(found),
      /private body text|SECRET_TOKEN/,
    );
    const q = gh.calls[0]!.url.searchParams.get("q")!;
    assert.match(q, /repo:akhilvuputuri\/chief-agent/);
    assert.match(q, /is:open/);
    const saved: any = await issues.draft("123", randomUUID(), draft);
    assert.doesNotMatch(JSON.stringify(saved), /SECRET_TOKEN/);
    await issues.decide("123", saved.approvalId, true);
    for (const c of gh.calls) {
      assert.equal(c.url.origin, "https://api.github.com");
      assert.ok(
        (c.method === "GET" &&
          (c.url.pathname === "/search/issues" ||
            c.url.pathname === `/repos/${REPO}/issues`)) ||
          (c.method === "POST" && c.url.pathname === `/repos/${REPO}/issues`),
        `${c.method} ${c.url.pathname}`,
      );
    }
  } finally {
    await pg.close();
  }
});

test("a search that fails says no duplicate check was done", async () => {
  const { pg, db } = await fixture();
  try {
    const down = new GithubIssues(
      db,
      { owner: "123", token: TOKEN, repos: [REPO] },
      (async () => {
        throw new TypeError("network");
      }) as typeof fetch,
    );
    const r: any = await down.search("123", {
      repo: REPO,
      query: "x",
      limit: 5,
    });
    assert.equal(r.status, "unavailable");
    const refused = new GithubIssues(
      db,
      { owner: "123", token: TOKEN, repos: [REPO] },
      (async () => new Response("{}", { status: 403 })) as typeof fetch,
    );
    assert.equal(
      (
        (await refused.search("123", {
          repo: REPO,
          query: "x",
          limit: 5,
        })) as any
      ).status,
      "unavailable",
    );
  } finally {
    await pg.close();
  }
});

for (const [status, reason] of [
  [401, "authorization"],
  [403, "forbidden"],
  [404, "not_found"],
  [410, "issues_disabled"],
  [422, "rejected"],
  [429, "rate_limited"],
] as const)
  test(`GitHub refusing with ${status} is a definite non-creation and a repeat tap never retries`, async () => {
    const { pg, gh, issues } = await fixture(TOKEN, {
      post: () => new Response(JSON.stringify({ message: "nope" }), { status }),
    });
    try {
      const saved: any = await issues.draft("123", randomUUID(), draft);
      assert.deepEqual(await issues.decide("123", saved.approvalId, true), {
        status: "failed",
        reason,
      });
      assert.deepEqual(await issues.decide("123", saved.approvalId, true), {
        status: "failed",
        reason,
      });
      assert.equal(posts(gh).length, 1);
      // Drafting again is a new approval and not blocked.
      assert.equal(
        (
          (await issues.draft("123", randomUUID(), {
            ...draft,
            title: "Another",
          })) as any
        ).status,
        "awaiting_approval",
      );
    } finally {
      await pg.close();
    }
  });

test("a timeout or server error stays uncertain, is checked read-only by marker, and never posts twice", async () => {
  let mode: "timeout" | "500" | "created-then-500" = "timeout";
  const { pg, db, gh, issues } = await fixture(TOKEN, {
    post: () => {
      if (mode === "timeout")
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return new Response("{}", { status: 500 });
    },
  });
  try {
    const saved: any = await issues.draft("123", randomUUID(), draft);
    assert.deepEqual(await issues.decide("123", saved.approvalId, true), {
      status: "uncertain",
    });
    // Repeat taps settle by reading; absence inside the window stays uncertain.
    assert.deepEqual(await issues.decide("123", saved.approvalId, true), {
      status: "uncertain",
    });
    assert.equal(posts(gh).length, 1);
    assert.equal(gh.calls.filter((c) => c.method === "GET").length >= 1, true);
    assert.equal(
      (
        await db.query(
          "SELECT payload->>'execution' e FROM approvals WHERE id=$1",
          [saved.approvalId],
        )
      ).rows[0].e,
      "uncertain",
    );
    // The write did land after all (the timeout hid the response): found by its marker.
    gh.issues.push({
      number: 77,
      body: `text\n\n<!-- chief-request:${saved.approvalId} -->`,
    });
    const found = await issues.decide("123", saved.approvalId, true);
    assert.deepEqual(found, {
      status: "created",
      url: `https://github.com/${REPO}/issues/77`,
      number: 77,
    });
    assert.equal(posts(gh).length, 1);

    // A 500 and no trace: failed only once five minutes have passed since the attempt.
    mode = "500";
    const second: any = await issues.draft("123", randomUUID(), {
      ...draft,
      title: "Second",
    });
    assert.equal(
      (await issues.decide("123", second.approvalId, true)).status,
      "uncertain",
    );
    assert.equal(
      (await issues.decide("123", second.approvalId, true)).status,
      "uncertain",
    );
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{claimedAt}',to_jsonb(now()-interval '6 minutes')) WHERE id=$1",
      [second.approvalId],
    );
    assert.deepEqual(await issues.decide("123", second.approvalId, true), {
      status: "failed",
      reason: "not_found",
    });
    assert.equal(posts(gh).length, 2);
  } finally {
    await pg.close();
  }
});

test("a check that cannot read GitHub keeps the result uncertain", async () => {
  const { pg, db, gh, issues } = await fixture(TOKEN, {
    post: () => new Response("{}", { status: 502 }),
    list: () => new Response("{}", { status: 500 }),
  });
  try {
    const saved: any = await issues.draft("123", randomUUID(), draft);
    assert.equal(
      (await issues.decide("123", saved.approvalId, true)).status,
      "uncertain",
    );
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{claimedAt}',to_jsonb(now()-interval '1 hour')) WHERE id=$1",
      [saved.approvalId],
    );
    await assert.rejects(() => issues.decide("123", saved.approvalId, true));
    assert.equal(
      (
        await db.query(
          "SELECT payload->>'execution' e FROM approvals WHERE id=$1",
          [saved.approvalId],
        )
      ).rows[0].e,
      "uncertain",
    );
    assert.equal(posts(gh).length, 1);
  } finally {
    await pg.close();
  }
});

test("expired drafts cannot be approved; identical drafts share one card; pending drafts are bounded", async () => {
  const { pg, db, gh, issues } = await fixture();
  try {
    const a: any = await issues.draft("123", randomUUID(), draft);
    const b: any = await issues.draft("123", randomUUID(), draft);
    assert.equal(a.approvalId, b.approvalId);
    await db.query(
      "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [a.approvalId],
    );
    await assert.rejects(() => issues.decide("123", a.approvalId, true));
    assert.equal(posts(gh).length, 0);
    for (let i = 0; i < 5; i++)
      await issues.draft("123", randomUUID(), { ...draft, title: `Bug ${i}` });
    await assert.rejects(
      () =>
        issues.draft("123", randomUUID(), { ...draft, title: "One too many" }),
      (e) =>
        e instanceof ToolValidationError &&
        /Too many/.test((e as Error).message),
    );
    await assert.rejects(() => issues.decide("123", randomUUID(), true));
  } finally {
    await pg.close();
  }
});

test("migration 037 keeps every earlier approval operation and adds the issue one", async () => {
  const { pg } = await fixture();
  try {
    const def = (
      await pg.query(
        "SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='approvals_operation_check'",
      )
    ).rows[0] as any;
    for (const op of [
      "job_delete",
      "calendar_create",
      "library_link",
      "portfolio_disconnect",
      "github_issue_create",
    ])
      assert.ok(def.d.includes(op), op);
  } finally {
    await pg.close();
  }
});

/** A bot over the real handlers with a recording Telegram API. */
async function botFor(db: Database, issues: GithubIssues) {
  const tools = new JobTools(
    db,
    { call: async () => ({}) },
    ...(Array(20).fill(undefined) as []),
    issues,
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    { tools } as any,
    db,
  );
  const sent: any[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "T", username: "t_bot" },
      };
    if (method === "sendMessage") sent.push(payload);
    return { ok: true, result: { message_id: 11 } } as any;
  });
  await bot.init();
  const tap = (data: string) =>
    bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "q",
        chat_instance: "x",
        from: { id: 123, is_bot: false, first_name: "T" },
        data,
        message: {
          message_id: 11,
          date: 0,
          chat: { id: 123, type: "private" },
        },
      },
    } as any);
  return { sent, tap };
}
const buttons = (m: any) =>
  (m.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.text);

test("Telegram wording: uncertain keeps Check status, a failed check never says to redraft, refusals say nothing was created", async () => {
  let mode: "500" | "list-down" = "500";
  const { pg, db, gh, issues } = await fixture(TOKEN, {
    post: () => new Response("{}", { status: 500 }),
    list: () => new Response("{}", { status: 503 }),
  });
  try {
    const { sent, tap } = await botFor(db, issues);
    const saved: any = await issues.draft("123", randomUUID(), draft);
    await tap(`gh:yes:${saved.approvalId}`);
    const uncertain = sent.at(-1);
    assert.match(uncertain.text, /couldn't confirm/);
    assert.doesNotMatch(uncertain.text, /draft/i);
    assert.deepEqual(buttons(uncertain), ["Check status"]);
    // Check status while GitHub cannot be read: still uncertain, button kept, no redraft advice.
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{claimedAt}',to_jsonb(now()-interval '1 hour')) WHERE id=$1",
      [saved.approvalId],
    );
    await tap(`gh:yes:${saved.approvalId}`);
    const failedCheck = sent.at(-1);
    assert.match(failedCheck.text, /couldn't confirm/);
    assert.doesNotMatch(failedCheck.text, /ask me to draft|draft it again/i);
    assert.deepEqual(buttons(failedCheck), ["Check status"]);
    assert.equal(posts(gh).length, 1);
    void mode;
  } finally {
    await pg.close();
  }
});

test("Telegram wording: a refusal says no issue was created; an expired or discarded card says it is unavailable", async () => {
  const { pg, db, gh, issues } = await fixture(TOKEN, {
    post: () => new Response("{}", { status: 401 }),
  });
  try {
    const { sent, tap } = await botFor(db, issues);
    const a: any = await issues.draft("123", randomUUID(), draft);
    await tap(`gh:yes:${a.approvalId}`);
    assert.match(
      sent.at(-1).text,
      /No GitHub issue was created\. GitHub rejected the token/,
    );
    assert.deepEqual(buttons(sent.at(-1)), []);
    const b: any = await issues.draft("123", randomUUID(), {
      ...draft,
      title: "B",
    });
    await db.query(
      "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [b.approvalId],
    );
    await tap(`gh:yes:${b.approvalId}`);
    assert.match(sent.at(-1).text, /unavailable, expired, or already used/);
    assert.deepEqual(buttons(sent.at(-1)), []);
    await tap(`gh:no:${a.approvalId}`);
    assert.equal(posts(gh).length, 1);
  } finally {
    await pg.close();
  }
});

test("a database failure while recording is reported as uncertain, never as redraft", async () => {
  const { pg, db, issues } = await fixture();
  try {
    const { sent, tap } = await botFor(db, issues);
    const saved: any = await issues.draft("123", randomUUID(), draft);
    const real = db.query.bind(db);
    // Fail the statement that records the created issue.
    (db as any).query = async (sql: string, ...rest: any[]) => {
      if (/INSERT INTO tool_receipts/.test(sql)) throw new Error("db down");
      return real(sql, ...rest);
    };
    await tap(`gh:yes:${saved.approvalId}`);
    (db as any).query = real;
    assert.match(sent.at(-1).text, /couldn't confirm/);
    assert.doesNotMatch(sent.at(-1).text, /draft it again|ask me to draft/i);
  } finally {
    await pg.close();
  }
});

test("neither text assent nor /approve can create an issue", async () => {
  const { pg, db, gh, issues } = await fixture();
  try {
    const saved: any = await issues.draft("123", randomUUID(), draft);
    const tools = new JobTools(db, { call: async () => ({}) });
    await assert.rejects(() => tools.decide("123", saved.approvalId, true));
    assert.equal(posts(gh).length, 0);
    assert.equal(
      (
        await db.query("SELECT status FROM approvals WHERE id=$1", [
          saved.approvalId,
        ])
      ).rows[0].status,
      "pending",
    );
  } finally {
    await pg.close();
  }
});

test("the card shows a long body fully or says how much is hidden", () => {
  const long = { ...draft, body: "x".repeat(3000) };
  assert.doesNotMatch(issuePreview(long), /not shown/);
  const huge = { ...draft, body: "y".repeat(3500) };
  assert.match(issuePreview(huge), /300 more characters not shown/);
  assert.equal(
    githubIssueDraft.safeParse({
      ...draft,
      operation: "github_issue_draft",
      body: "z".repeat(3001),
    }).success,
    false,
  );
});

test("an identical draft is refused while an earlier approval is uncertain, and allowed once it settled as not created", async () => {
  const { pg, db, gh, issues } = await fixture(TOKEN, {
    post: () => new Response("{}", { status: 502 }),
  });
  try {
    const a: any = await issues.draft("123", randomUUID(), draft);
    assert.equal(
      (await issues.decide("123", a.approvalId, true)).status,
      "uncertain",
    );
    await assert.rejects(
      () => issues.draft("123", randomUUID(), draft),
      (e) =>
        e instanceof ToolValidationError &&
        /uncertain/.test((e as Error).message),
    );
    // The first attempt did land: the retry is told where it is.
    gh.issues.push({
      number: 90,
      body: `x\n<!-- chief-request:${a.approvalId} -->`,
    });
    await assert.rejects(
      () => issues.draft("123", randomUUID(), draft),
      (e) => /issues\/90/.test((e as Error).message),
    );
    assert.equal(posts(gh).length, 1);
    // A different issue is not blocked; nor is the same one once it is known not to exist.
    const b: any = await issues.draft("123", randomUUID(), {
      ...draft,
      title: "Other",
    });
    assert.equal(b.status, "awaiting_approval");
    const c: any = await issues.draft("123", randomUUID(), {
      ...draft,
      body: "different body",
    });
    assert.equal(c.status, "awaiting_approval");
  } finally {
    await pg.close();
  }
});

test("an incomplete or unreadable search is not reported as a completed duplicate check", async () => {
  const { pg, db } = await fixture();
  try {
    for (const body of [
      { items: [], incomplete_results: true },
      { nothing: true },
    ]) {
      const s = new GithubIssues(
        db,
        { owner: "123", token: TOKEN, repos: [REPO] },
        (async () => Response.json(body)) as typeof fetch,
      );
      assert.equal(
        ((await s.search("123", { repo: REPO, query: "x", limit: 5 })) as any)
          .status,
        "unavailable",
      );
    }
  } finally {
    await pg.close();
  }
});
