import { test } from "node:test";
import assert from "node:assert/strict";
import { JevNewsRanker, readNewsRankerConfig } from "../src/news-ranker.js";
import { composeSelection, type Scored } from "../src/news.js";

const config = readNewsRankerConfig();
const reply = (answers: Record<string, unknown>, cost: unknown = 0.00004) =>
  new Response(
    JSON.stringify({
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, p]) => [k, { noul: p }]),
      ),
      usage: { cost },
      model: "typesafe/jev-1.13-20260917",
    }),
  );
const candidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `site.example/${i}`,
    title: `Story ${i}`,
    site: "site.example",
    ...(i % 2 ? { excerpt: "x".repeat(500) } : {}),
  }));

test("the ranker asks one yes/no question per shortlisted candidate, one request each", async () => {
  const bodies: any[] = [];
  let inFlight = 0,
    peak = 0;
  const ranker = new JevNewsRanker("key", config, (async (
    _url: string,
    init: RequestInit,
  ) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return reply({
      save: Number(body.state.candidate.title.split(" ")[1]) / 100,
    });
  }) as typeof fetch);
  const saves = Array.from({ length: 30 }, (_, i) => `Saved ${i}`);
  const r = await ranker.score({
    topics: ["ai"],
    saves,
    candidates: candidates(config.maxCandidates + 5),
  });
  assert.equal(r.ok, true);
  assert.equal(r.asked, config.maxCandidates);
  assert.equal(r.requests, config.maxCandidates);
  assert.ok(peak <= config.concurrency, `peak ${peak}`);
  // Only the shortlist is scored, each under its own key.
  assert.equal(r.scores.size, config.maxCandidates);
  assert.equal(r.scores.get("site.example/7"), 0.07);
  assert.equal(r.scores.has(`site.example/${config.maxCandidates}`), false);
  // Each request holds one candidate, the bounded profile and one noul question.
  for (const b of bodies) {
    assert.deepEqual(Object.keys(b.questions), ["save"]);
    assert.equal(b.questions.save.type, "noul");
    assert.equal(b.state.recent_saves.length, config.state.recentSaves);
    assert.equal(b.state.candidates, undefined);
  }
  const withExcerpt = bodies.find((b) => b.state.candidate.excerpt);
  assert.equal(
    withExcerpt.state.candidate.excerpt.length,
    config.state.excerptChars,
  );
  assert.equal(r.costUsd!.toFixed(8), (0.00004 * r.requests).toFixed(8));
  assert.match(ranker.version, /^[0-9a-f]{12}$/);
});

test("a rate limit or server error is retried once; other failures fail the ranking", async () => {
  let calls = 0;
  const flaky = await new JevNewsRanker(
    "key",
    { ...config, concurrency: 1 },
    (async () =>
      ++calls === 1
        ? new Response("busy", { status: 429 })
        : reply({ save: 0.5 })) as typeof fetch,
    async () => {},
  ).score({ topics: [], saves: [], candidates: candidates(2) });
  assert.equal(flaky.ok, true);
  assert.equal(flaky.requests, 3);
  const cases: [typeof fetch, string][] = [
    [
      (async () => new Response("no", { status: 503 })) as typeof fetch,
      "http_503",
    ],
    [
      (async () => new Response("no", { status: 400 })) as typeof fetch,
      "http_400",
    ],
    [(async () => reply({ save: 1.5 })) as typeof fetch, "invalid"],
    [(async () => reply({})) as typeof fetch, "invalid"],
    [
      (async () => {
        throw new Error("network");
      }) as typeof fetch,
      "failed",
    ],
  ];
  for (const [transport, error] of cases) {
    const r = await new JevNewsRanker("key", config, transport).score({
      topics: [],
      saves: [],
      candidates: candidates(3),
    });
    assert.equal(r.ok, false, error);
    assert.equal(r.error, error);
    assert.equal(r.scores.size, 0);
    assert.equal(r.costUsd, null);
  }
  const alive = setInterval(() => {}, 1000);
  const slow = await new JevNewsRanker(
    "key",
    { ...config, timeoutMs: 20 },
    ((_: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
        ),
      )) as typeof fetch,
  ).score({ topics: [], saves: [], candidates: candidates(2) });
  clearInterval(alive);
  assert.equal(slow.error, "timeout");
  // The whole ranking stops at its deadline, however many requests remain.
  const hanging = ((_: string, init: RequestInit) =>
    new Promise((_r, reject) =>
      init.signal!.addEventListener("abort", () =>
        reject(Object.assign(new Error("a"), { name: "AbortError" })),
      ),
    )) as typeof fetch;
  const alive2 = setInterval(() => {}, 1000);
  const started = Date.now();
  const late = await new JevNewsRanker(
    "key",
    { ...config, timeoutMs: 60_000, deadlineMs: 30 },
    hanging,
  ).score({ topics: [], saves: [], candidates: candidates(20) });
  clearInterval(alive2);
  assert.equal(late.ok, false);
  assert.equal(late.error, "deadline");
  assert.ok(Date.now() - started < 5000);
  const unknown = await new JevNewsRanker("key", config, (async () =>
    reply({ save: 0.5 }, null)) as typeof fetch).score({
    topics: [],
    saves: [],
    candidates: candidates(2),
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.costUsd, null);
  const none = await new JevNewsRanker("key", config, (async () => {
    throw new Error("not called");
  }) as typeof fetch).score({ topics: [], saves: [], candidates: [] });
  assert.equal(none.ok, true);
  assert.equal(none.requests, 0);
});

const item = (n: number, total: number, domain = `s${n}.example`): Scored => ({
  sourceId: `src${n}`,
  sourceName: `S${n}`,
  domain,
  canonical: `${domain}/${n}`,
  topics: [],
  entry: {
    title: `T${n}`,
    url: `https://${domain}/${n}`,
    summary: null,
    categories: [],
    publishedAt: null,
  },
  score: { interest: 0, recency: 0, site: 0, similar: 0, total },
});
// Deterministic order: highest total first, as rankCandidates returns it.
const pool = Array.from({ length: 10 }, (_, i) => item(i, 10 - i));

test("Jev's probabilities order the regular picks; unscored candidates follow", () => {
  const jev = new Map([
    ["s7.example/7", 0.9],
    ["s3.example/3", 0.8],
    ["s0.example/0", 0.2],
  ]);
  const s = composeSelection(pool, { count: 3, jev, random: () => 0.999999 });
  // Two regular picks in Jev's order, then the exploration pick (appended).
  assert.deepEqual(
    s.items.slice(0, 2).map((x) => x.canonical),
    ["s7.example/7", "s3.example/3"],
  );
  assert.ok(s.explored);
  assert.equal(s.items.at(-1), s.explored);
  assert.ok(!["s7.example/7", "s3.example/3"].includes(s.explored!.canonical));
});

test("reciprocal-rank fusion blends Jev's order with the deterministic one", () => {
  // Jev puts the deterministic last first; the rules put it last.
  const jev = new Map(
    pool.map((p, i) => [p.canonical, i === 9 ? 0.99 : 0.5 - i / 100]),
  );
  const pure = composeSelection(pool, {
    count: 2,
    jev,
    order: "jev",
    random: () => 0,
  });
  const fused = composeSelection(pool, {
    count: 2,
    jev,
    order: "rrf",
    random: () => 0,
  });
  const regular = (s: typeof pure) => s.items.filter((x) => x !== s.explored);
  assert.equal(regular(pure)[0]!.canonical, "s9.example/9");
  // Fused, the item both rankers like (rank 0 by rules, 1 by Jev) wins.
  assert.equal(regular(fused)[0]!.canonical, "s0.example/0");
});

test("the exploration pick keeps the per-site cap when another site can fill it", () => {
  // The regular picks take two items from one site; the window holds more of it and one other.
  const crowded = [
    item(0, 10, "a.example"),
    item(1, 9, "a.example"),
    item(2, 8, "a.example"),
    item(3, 7, "a.example"),
    item(4, 6, "b.example"),
  ];
  const s = composeSelection(crowded, { count: 3, random: () => 0 });
  assert.equal(s.explored!.domain, "b.example");
  assert.equal(s.probability, 1);
  assert.equal(s.items.filter((x) => x.domain === "a.example").length, 2);
});

test("the exploration slot comes from the top window at a random position, with its probability", () => {
  const draws = [0.5, 0];
  const s = composeSelection(pool, {
    count: 5,
    exploreWindow: 6,
    random: () => draws.shift()!,
  });
  // Four regular picks; the spare window is ranks 5–6 (two items), the draw picks the second.
  assert.equal(s.items.length, 5);
  assert.equal(s.probability, 1 / 2);
  assert.equal(s.explored!.canonical, "s5.example/5");
  assert.equal(s.items[0], s.explored);
  // No room for a second slot type: one item means no exploration.
  const one = composeSelection(pool, { count: 1, random: () => 0 });
  assert.equal(one.items.length, 1);
  assert.equal(one.explored, undefined);
  // No spare candidate: the edition is filled normally.
  const short = composeSelection(pool.slice(0, 3), {
    count: 5,
    random: () => 0,
  });
  assert.equal(short.items.length, 3);
  assert.equal(short.explored, undefined);
});
