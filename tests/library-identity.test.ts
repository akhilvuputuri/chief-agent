import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { open, seal, secretKey } from "../src/secret-box.js";
import { LibraryClient } from "../src/library-client.js";
import { PostgresPacing } from "../src/library-pacing.js";
import { LibraryIdentity, daysLeft } from "../src/library-identity.js";
import { LinkCeremony, type LinkOutcome } from "../src/library-link.js";
import { LibraryActions } from "../src/library-actions.js";
import { recoverLibrary } from "../src/library-recovery.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";

const KEY = secretKey("ab".repeat(32));
const TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJjaGlwIjoiYWJjZGVmZ2gifQ.c2lnbmF0dXJlc2lnbmF0dXJl";
const TOKEN2 =
  "eyJhbGciOiJIUzI1NiJ9.eyJjaGlwIjoic2Vjb25kdG9rZW4ifQ.c2Vjb25kc2lnbmF0dXJlYWJj";

async function database() {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${name}`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  return { pg, db };
}
type Script = { result: string; code?: string }[];
function harness(
  db: Database,
  options: {
    codes?: Script;
    sync?: () => unknown;
    clone?: () => Response;
    enter?: () => Response;
  } = {},
) {
  let now = Date.UTC(2026, 8, 20, 4, 0, 0);
  const calls: { url: URL; init: RequestInit }[] = [];
  const edits: { messageId: number; text: string; buttons: string[] }[] = [];
  const finished: { approvalId: string; outcome: LinkOutcome }[] = [];
  const codes = [...(options.codes ?? [])];
  let mints = 0;
  const client = new LibraryClient({
    pacing: new PostgresPacing(db, () => now),
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      now += ms;
    },
    request: (async (input: any, init: any) => {
      const url = new URL(input);
      calls.push({ url, init });
      const p = url.pathname;
      if (p === "/chip" && init.method === "POST")
        return Response.json({
          identity: mints++ === 0 ? TOKEN : TOKEN2,
          expiry: Math.floor(now / 1000) + 7 * 86400,
        });
      if (p === "/chip/clone/code" && init.method === "GET")
        return Response.json(
          codes.shift() ?? { result: "retained", code: "11112222" },
        );
      if (p === "/chip/clone/code")
        return (options.enter ?? (() => Response.json({})))();
      if (p === "/chip/clone")
        return (options.clone ?? (() => Response.json({})))();
      if (p === "/chip/sync")
        return Response.json(
          options.sync?.() ?? {
            cards: [
              {
                cardId: "card-1",
                library: { websiteId: 106 },
                limits: { loan: 5, hold: 8 },
              },
            ],
            loans: [
              {
                id: "5665700",
                title: "Project Hail Mary",
                firstCreatorName: "Andy Weir",
                type: { id: "ebook" },
                checkoutDate: "2026-09-18T00:00:00Z",
                expireDate: "2026-10-09T00:00:00Z",
              },
            ],
            holds: [
              {
                id: "77",
                title: "Dune",
                isAvailable: false,
                estimatedWaitDays: 40,
                placedDate: "2026-09-01T00:00:00Z",
              },
            ],
          },
        );
      if (p === "/chip/revoke") return Response.json({});
      return new Response("", { status: 404 });
    }) as typeof fetch,
  });
  const identity = new LibraryIdentity(db, client, KEY, () => now);
  const api = {
    editMessageText: async (
      _chat: string,
      messageId: number,
      text: string,
      extra?: any,
    ) => {
      edits.push({
        messageId,
        text,
        buttons: (extra?.reply_markup?.inline_keyboard ?? [])
          .flat()
          .map((b: any) => b.callback_data),
      });
      return true;
    },
  };
  let actions: LibraryActions;
  const link = new LinkCeremony(
    db,
    client,
    identity,
    api,
    async (user, approvalId, outcome) => {
      finished.push({ approvalId, outcome });
      await actions.linkFinished(user, approvalId, outcome);
    },
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  actions = new LibraryActions(db, { identity, link, client }, "123");
  return {
    client,
    identity,
    link,
    actions,
    calls,
    edits,
    finished,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}
async function settled(db: Database, approvalId: string, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const row = (
      await db.query(
        "SELECT payload->>'execution' AS e FROM approvals WHERE id=$1",
        [approvalId],
      )
    ).rows[0];
    if (row && row.e !== "executing") return row.e as string;
    if (Date.now() - started > timeoutMs)
      throw new Error("attempt did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function leakScan(db: Database, needles: string[], extra: string[] = []) {
  const stores = [
    "SELECT data::text AS t FROM events",
    "SELECT payload::text AS t FROM approvals",
    "SELECT details::text AS t FROM tool_receipts",
    "SELECT encode(token_box,'escape') AS t FROM library_identities",
    "SELECT loans::text || holds::text AS t FROM library_shelf",
    "SELECT COALESCE(last_result,'') AS t FROM library_link_attempts",
  ];
  const texts = [...extra];
  for (const sql of stores)
    for (const row of (await db.query(sql)).rows)
      texts.push(String(row.t ?? ""));
  for (const needle of needles)
    for (const text of texts)
      assert.ok(
        !text.includes(needle),
        `leaked ${needle.slice(0, 12)} in ${text.slice(0, 80)}`,
      );
}

test("secret-box seals and opens with AAD binding and detects tampering", () => {
  const box = seal(
    KEY,
    JSON.stringify({ bearer: TOKEN }),
    "library-identity-v1:123",
  );
  assert.equal(
    open(KEY, box, "library-identity-v1:123"),
    JSON.stringify({ bearer: TOKEN }),
  );
  assert.throws(() => open(KEY, box, "library-identity-v1:456"), /unreadable/);
  const tampered = Buffer.from(box);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => open(KEY, tampered, "library-identity-v1:123"),
    /unreadable/,
  );
  assert.throws(() => secretKey("short"));
  assert.ok(!box.toString("latin1").includes(TOKEN.slice(0, 20)));
  assert.equal(daysLeft("2026-10-09T00:00:00Z", Date.UTC(2026, 8, 20)), 19);
  assert.equal(daysLeft(undefined, 0), null);
});

test("the linking ceremony displays a rotating code, completes on fulfilled, links the card and leaks no secret", async () => {
  const { pg, db } = await database();
  try {
    const h = harness(db, {
      codes: [
        { result: "regenerated", code: "48219037" },
        { result: "retained", code: "48219037" },
        { result: "regenerated", code: "10203040" },
        { result: "fulfilled" },
      ],
    });
    const draft = await h.actions.draft(
      "123",
      randomUUID(),
      "library_link",
      {},
      { source: "command" },
    );
    assert.match(draft.preview, /Copy To Another Device/);
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{telegramMessageId}','11') WHERE id=$1",
      [draft.approvalId],
    );
    const decided = await h.actions.decide("123", draft.approvalId!, true, {
      chat: "123",
    });
    assert.equal(decided.status, "linking");
    assert.equal(await settled(db, draft.approvalId!), "created");
    const row = await h.identity.row("123");
    assert.equal(row?.state, "linked");
    assert.equal(row?.card_id, "card-1");
    const paths = h.calls.map((c) => `${c.init.method} ${c.url.pathname}`);
    assert.deepEqual(paths, [
      "POST /chip",
      "GET /chip/clone/code",
      "GET /chip/clone/code",
      "GET /chip/clone/code",
      "GET /chip/clone/code",
      "POST /chip/clone",
      "POST /chip",
      "GET /chip/sync",
    ]);
    // Code edits: two distinct codes → two progress edits, then confirming, then done.
    const texts = h.edits.map((e) => e.text);
    assert.equal(texts.filter((t) => t.includes("4821 9037")).length, 1);
    assert.equal(texts.filter((t) => t.includes("1020 3040")).length, 1);
    assert.match(texts.at(-1)!, /Linked to NLB\. Shelf now: 1 loan, 1 hold/);
    assert.ok(h.edits[0]!.buttons[0]!.startsWith("lib:abort:"));
    assert.equal(h.finished[0]!.outcome.status, "done");
    const shelf = await h.identity.snapshot("123");
    assert.equal(shelf!.loans[0]!.daysLeft, 19);
    assert.equal(shelf!.capacity.loans.limit, 5);
    assert.ok(!JSON.stringify(shelf).includes("card-1"));
    const events = (
      await db.query(
        "SELECT data FROM events WHERE type='library.link_progress'",
      )
    ).rows;
    assert.equal(events.length, 4);
    await leakScan(
      db,
      [TOKEN, TOKEN2, "48219037", "10203040"],
      texts.filter((t) => !t.startsWith("Linking — step 1")),
    );
    const watch = (
      await db.query("SELECT status FROM library_watch WHERE user_id='123'")
    ).rows[0];
    assert.equal(watch?.status, "scheduled");
  } finally {
    await pg.close();
  }
});

test("abort, deadline and a missing card each end the attempt without linking; restart recovery is conservative", async () => {
  const { pg, db } = await database();
  try {
    const h = harness(db, {
      codes: [{ result: "regenerated", code: "12345678" }],
    });
    const a = await h.actions.draft(
      "123",
      randomUUID(),
      "library_link",
      {},
      { source: "command" },
    );
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{telegramMessageId}','11') WHERE id=$1",
      [a.approvalId],
    );
    await h.actions.decide("123", a.approvalId!, true);
    const attempt = (
      await db.query(
        "SELECT id FROM library_link_attempts WHERE approval_id=$1",
        [a.approvalId],
      )
    ).rows[0];
    await db.query(
      "UPDATE library_link_attempts SET abort_requested=true WHERE id=$1",
      [attempt.id],
    );
    assert.equal(await settled(db, a.approvalId!), "failed");
    assert.equal(
      (
        await db.query("SELECT state FROM library_link_attempts WHERE id=$1", [
          attempt.id,
        ])
      ).rows[0].state,
      "aborted",
    );
    assert.equal(await h.identity.row("123"), undefined);
    assert.match(h.edits.at(-1)!.text, /Stopped/);
    // Deadline: the code never fulfils within five minutes.
    const b = await h.actions.draft(
      "123",
      randomUUID(),
      "library_link",
      {},
      { source: "command" },
    );
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{telegramMessageId}','12') WHERE id=$1",
      [b.approvalId],
    );
    await h.actions.decide("123", b.approvalId!, true);
    assert.equal(await settled(db, b.approvalId!), "failed");
    assert.match(
      h.edits.at(-1)!.text,
      /did not complete in 5 minutes[\s\S]*Copy To Another Device/,
    );
    assert.ok(!h.edits.at(-1)!.text.includes("Recover Your Data →"));
    assert.equal(await h.link.attemptsToday("123"), 2);
    const third = await h.actions.command("123", "link", undefined, "123");
    assert.match(third.text, /Two linking attempts/);
    // Recovery: a displaying attempt left by a crash is aborted and its anonymous chip forgotten.
    const c = randomUUID();
    await db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,status) VALUES($1,'123',$2,'library_link','{\"execution\":\"executing\"}','approved')",
      [c, randomUUID()],
    );
    await db.query(
      "INSERT INTO library_link_attempts(id,user_id,approval_id,direction,state,deadline_at) VALUES($1,'123',$2,'display','displaying',now()+interval '5 minutes')",
      [randomUUID(), c],
    );
    await db.query(
      "INSERT INTO library_identities(user_id,state) VALUES('123','linking')",
    );
    const d = randomUUID();
    await db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,status) VALUES($1,'123',$2,'library_revoke','{\"execution\":\"executing\",\"sentAt\":\"x\"}','approved')",
      [d, randomUUID()],
    );
    const recovered = await recoverLibrary(db);
    assert.deepEqual(recovered, {
      recovered: true,
      failed: 0,
      uncertain: 1,
      aborted: 1,
    });
    assert.equal(
      (
        await db.query(
          "SELECT payload->>'execution' e FROM approvals WHERE id=$1",
          [c],
        )
      ).rows[0].e,
      "failed",
    );
    assert.equal(
      (
        await db.query(
          "SELECT payload->>'execution' e FROM approvals WHERE id=$1",
          [d],
        )
      ).rows[0].e,
      "uncertain",
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM library_identities")).rows[0]
        .n,
      0,
    );
  } finally {
    await pg.close();
  }
});

test("the fallback code entry, re-mint, expiry marking and revoke behave without ever returning the token", async () => {
  const { pg, db } = await database();
  try {
    const h = harness(db, { codes: [] });
    const a = await h.actions.draft(
      "123",
      randomUUID(),
      "library_link",
      {},
      { source: "command" },
    );
    await h.actions.decide("123", a.approvalId!, true);
    assert.equal(await settled(db, a.approvalId!), "failed");
    const entered = await h.actions.command("123", "code", "87654321", "123");
    const detail = (
      await db.query(
        "SELECT last_result FROM library_link_attempts WHERE direction='enter'",
      )
    ).rows[0]?.last_result;
    assert.match(entered.text, /Linked to NLB/, `attempt detail: ${detail}`);
    const enter = h.calls.find(
      (c) => c.url.pathname === "/chip/clone/code" && c.init.method === "POST",
    )!;
    assert.deepEqual(JSON.parse(String(enter.init.body)), {
      code: "87654321",
      role: "pointer",
    });
    assert.equal((await h.identity.row("123"))?.state, "linked");
    await assert.rejects(h.actions.command("456", "shelf", undefined, "456"));
    // Shelf read through the identity: the link's own sync is cached, a later read syncs once.
    const before = h.calls.length;
    const shelf = await h.identity.shelf("123");
    assert.equal(shelf.loans[0]!.title, "Project Hail Mary");
    assert.equal(h.calls.length, before);
    h.advance(16 * 60000);
    await h.identity.shelf("123");
    await h.identity.shelf("123");
    assert.equal(h.calls.length, before + 1);
    // Re-mint when the token is near expiry.
    assert.equal(await h.identity.needsRemint("123"), false);
    h.advance(6 * 86400000);
    assert.equal(await h.identity.needsRemint("123"), true);
    await h.identity.remint("123");
    assert.equal((await h.identity.row("123"))?.state, "linked");
    // Unauthenticated answers mark the identity expired.
    const broken = harness(db, { sync: () => ({}) });
    broken.calls.length = 0;
    const rejecting = new LibraryIdentity(
      db,
      new LibraryClient({
        pacing: new PostgresPacing(db, () => h.now()),
        now: () => h.now(),
        sleep: async () => {},
        request: (async () =>
          new Response("", { status: 401 })) as typeof fetch,
      }),
      KEY,
      () => h.now(),
    );
    await assert.rejects(rejecting.shelf("123"), /needs to be renewed/);
    assert.equal((await h.identity.row("123"))?.state, "expired");
    // Revoke: local wipe first, then one remote call; pending library cards are denied.
    await db.query(
      "UPDATE library_identities SET state='linked' WHERE user_id='123'",
    );
    const pendingLink = randomUUID();
    await db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,'123',$2,'library_link','{\"execution\":\"not_started\"}')",
      [pendingLink, randomUUID()],
    );
    const r = await h.actions.draft(
      "123",
      randomUUID(),
      "library_revoke",
      {},
      { source: "command" },
    );
    const decided = await h.actions.decide("123", r.approvalId!, true);
    assert.equal(decided.status, "created");
    assert.equal((decided as any).remote, true);
    const row = await h.identity.row("123");
    assert.equal(row?.state, "revoked");
    assert.equal(
      (
        await db.query(
          "SELECT token_box FROM library_identities WHERE user_id='123'",
        )
      ).rows[0].token_box,
      null,
    );
    assert.equal(
      (
        await db.query("SELECT status FROM approvals WHERE id=$1", [
          pendingLink,
        ])
      ).rows[0].status,
      "denied",
    );
    assert.equal(h.calls.at(-1)!.url.pathname, "/chip/revoke");
    assert.equal(
      (h.calls.at(-1)!.init.headers as any).authorization,
      "Bearer " + TOKEN2,
    );
    assert.match(LibraryActions.replyFor(decided), /Disconnected/);
    await leakScan(db, [TOKEN, TOKEN2, "87654321"]);
    assert.equal(readOperations.has("library_shelf"), true);
    assert.ok(
      !runtimeContext({ library: true }, null).tools.some(
        (t) => t.name === "library_shelf",
      ),
    );
    assert.ok(
      runtimeContext({ libraryAccount: true }, null).tools.some(
        (t) => t.name === "library_shelf",
      ),
    );
  } finally {
    await pg.close();
  }
});

test("an uncertain link is settled by Check shelf: discarded when no card appears, so a fresh attempt is allowed", async () => {
  const { pg, db } = await database();
  try {
    let cards: unknown[] = [];
    const h = harness(db, { sync: () => ({ cards, loans: [], holds: [] }) });
    const approvalId = randomUUID();
    await db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,status) VALUES($1,'123',$2,'library_link',$3::jsonb,'approved')",
      [
        approvalId,
        randomUUID(),
        JSON.stringify({
          draft: {},
          execution: "uncertain",
          startedAt: new Date().toISOString(),
        }),
      ],
    );
    await db.query(
      "INSERT INTO library_link_attempts(id,user_id,approval_id,direction,state,deadline_at) VALUES($1,'123',$2,'display','completing',now())",
      [randomUUID(), approvalId],
    );
    await h.identity.mint("123");
    assert.match(
      (await h.actions.command("123", "link", undefined, "123")).text,
      /already in progress/,
    );
    const first = await h.actions.decide("123", approvalId, true);
    assert.equal(first.status, "failed");
    assert.equal(await h.link.liveAttempt("123"), undefined);
    assert.equal(await h.identity.row("123"), undefined);
    assert.equal(h.calls.at(-1)!.url.pathname, "/chip/revoke");
    assert.match(
      (await h.actions.command("123", "link", undefined, "123")).text,
      /Sent you a card/,
    );
    // The same path links when the card has appeared.
    cards = [{ cardId: "card-2", advantageKey: "nlb" }];
    const second = randomUUID();
    await db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,status) VALUES($1,'123',$2,'library_link',$3::jsonb,'approved')",
      [
        second,
        randomUUID(),
        JSON.stringify({
          draft: {},
          execution: "uncertain",
          startedAt: new Date().toISOString(),
        }),
      ],
    );
    await db.query(
      "INSERT INTO library_link_attempts(id,user_id,approval_id,direction,state,deadline_at) VALUES($1,'123',$2,'display','completing',now())",
      [randomUUID(), second],
    );
    await h.identity.mint("123");
    const linked = await h.actions.decide("123", second, true);
    assert.equal(linked.status, "created");
    assert.equal((await h.identity.row("123"))?.state, "linked");
    assert.equal(await h.link.liveAttempt("123"), undefined);
  } finally {
    await pg.close();
  }
});
