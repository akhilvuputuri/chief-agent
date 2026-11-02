import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LinkClassifier,
  decodeEntities,
  jevModel,
  linkDecision,
  linkKey,
  linkReason,
  linkState,
  pageMetadata,
  parseLinkRouting,
  readLinkPage,
  readLinkRouting,
  type LinkFacts,
} from "../src/link-router.js";
import { readPickerConfig } from "../src/tool-picker.js";

const config = readLinkRouting();
const picker = readPickerConfig();

const page = {
  url: "https://example.com/agents",
  readable: true,
  title: "Building agent platforms",
  site: "example.com",
  topic: "Engineering",
  tags: ["agents"],
  excerpt: "A walkthrough of planner and tool loops.",
};
const facts: LinkFacts = { url: page.url, page };

const answers = (
  choice: string,
  probabilities: Record<string, unknown>,
  cue?: number,
) => ({
  destination: { choice, probabilities },
  ...(cue === undefined ? {} : { cue: { noul: cue } }),
});

test("the routing config is bundled, has no model id, and rejects unknown fields", () => {
  assert.ok(config.interests.includes("agent platforms"));
  assert.ok(config.apply.study > 0.5 && config.apply.reader > 0.5);
  // Jev's id lives in the picker config only, so this path can never diverge.
  assert.equal("model" in config, false);
  assert.match(jevModel(), /^typesafe\/jev-[\d.]+-\d{8}$/);
  assert.equal(jevModel(), picker.model);
  assert.throws(() => parseLinkRouting({ ...config, model: "other/model" }));
  assert.throws(() => parseLinkRouting({ ...config, extra: 1 }));
  assert.throws(() => parseLinkRouting({ ...config, interests: [] }));
});

test("a confident judgment routes to study or to Reader", () => {
  const study = linkDecision(
    config,
    answers("study", { study: 0.91, reader: 0.09 }),
  );
  assert.equal(study.verdict, "study");
  assert.equal(study.via, "reading");
  assert.equal(study.confidence, 0.91);
  const reader = linkDecision(
    config,
    answers("reader", { study: 0.12, reader: 0.88 }),
  );
  assert.equal(reader.verdict, "reader");
  assert.equal(reader.confidence, 0.88);
});

test("an explicit owner cue always wins, even against a weak choice", () => {
  // "for offline reading" on material the model leans towards studying.
  const reading = linkDecision(
    config,
    answers("reader", { study: 0.55, reader: 0.3 }, 0.92),
  );
  assert.equal(reading.verdict, "reader");
  assert.equal(reading.via, "cue");
  // The cue decided it, so its probability is the decision's confidence.
  assert.equal(reading.confidence, 0.92);
  // "for AI learning" on an essay the model leans towards reading.
  const studying = linkDecision(
    config,
    answers("study", { study: 0.22, reader: 0.7 }, 0.9),
  );
  assert.equal(studying.verdict, "study");
  assert.equal(studying.via, "cue");
});

test("a genuinely unsure case asks instead of choosing", () => {
  const unsure = linkDecision(
    config,
    answers("study", { study: 0.4, reader: 0.35 }),
  );
  assert.equal(unsure.verdict, "unsure");
  assert.equal(unsure.choice, "study");
  const weakCue = linkDecision(
    config,
    answers("reader", { study: 0.4, reader: 0.45 }, 0.4),
  );
  assert.equal(weakCue.verdict, "unsure");
});

test("a malformed answer is never a verdict", () => {
  for (const bad of [
    undefined,
    {},
    { destination: { choice: "both", probabilities: { both: 0.9 } } },
    { destination: { choice: "study", probabilities: { study: 1.4 } } },
    { destination: { choice: "reader", probabilities: {} } },
    answers("reader", { study: 0.1, reader: Number.NaN }),
  ]) {
    const decision = linkDecision(config, bad);
    assert.equal(decision.verdict, "unsure", JSON.stringify(bad));
    assert.notEqual(decision.verdict, "reader");
  }
});

/** A transport that answers the decisions endpoint with `body`, or fails. */
const transport = (
  body: unknown,
  status = 200,
  seen: { url?: string; init?: RequestInit } = {},
) =>
  (async (url: any, init: any) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

test("the classifier asks the decisions endpoint on the picker's Jev snapshot", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const classifier = new LinkClassifier(
    "test-key",
    config,
    transport(
      {
        model: picker.model,
        answers: {
          destination: {
            choice: "study",
            probabilities: { study: 0.82, reader: 0.18 },
          },
          cue: { noul: 0.05 },
        },
        usage: { cost: 0.002 },
      },
      200,
      seen,
    ),
  );
  const result = await classifier.classify({
    ...facts,
    ownerMessage: "save this",
  });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "study");
  assert.equal(result.model, picker.model);
  assert.equal(result.costUsd, 0.002);
  assert.match(seen.url!, /\/alpha\/decisions$/);
  const sent = JSON.parse(String(seen.init!.body));
  assert.equal(sent.model, picker.model);
  // The page's own words, the owner's words and the saved interests are the evidence.
  assert.equal(sent.state.link.title, page.title);
  assert.equal(sent.state.link.site, "example.com");
  assert.equal(sent.state.link.text, page.excerpt);
  assert.equal(sent.state.owner_message, "save this");
  assert.deepEqual(sent.state.saved_interests, config.interests);
  assert.equal(sent.questions.destination.type, "choice");
  assert.equal(sent.questions.cue.type, "noul");
});

test("a failed classification asks; it never turns into a Reader save", async () => {
  const cases: [string, typeof fetch][] = [
    [
      "timeout",
      (async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    ],
    ["http_500", transport("{}", 500)],
    ["http_401", transport("{}", 401)],
    ["invalid", transport({ answers: { destination: { choice: "?" } } })],
    ["not-json", transport("not json")],
  ];
  for (const [name, stub] of cases)
    for (const ownerMessage of [undefined, "save this for offline reading"]) {
      const classifier = new LinkClassifier("test-key", config, stub);
      const result = await classifier.classify({ ...facts, ownerMessage });
      assert.equal(result.ok, false, name);
      assert.equal(result.verdict, "unsure", name);
      assert.equal(result.confidence, 0, name);
      assert.ok(result.error, name);
    }
});

test("an unreadable page still classifies from the URL and the owner's words", async () => {
  const seen: { init?: RequestInit } = {};
  const classifier = new LinkClassifier(
    "test-key",
    config,
    transport(
      {
        answers: {
          destination: {
            choice: "study",
            probabilities: { study: 0.8, reader: 0.2 },
          },
        },
      },
      200,
      seen,
    ),
  );
  const facts: LinkFacts = {
    url: "https://x.com/someone/status/123",
    ownerMessage: "save this thread for AI learning",
    page: { url: "https://x.com/someone/status/123", readable: false },
  };
  const result = await classifier.classify(facts);
  assert.equal(result.verdict, "study");
  const sent = JSON.parse(String(seen.init!.body));
  assert.equal(sent.state.link.readable, false);
  assert.equal(sent.state.link.title, null);
  assert.equal(sent.state.owner_message, "save this thread for AI learning");
});

test("duplicate detection ignores www, trailing slashes, tracking and fragments", () => {
  assert.equal(
    linkKey("https://www.Example.com/agents/?utm_source=x&id=7#top"),
    linkKey("https://example.com/agents?id=7"),
  );
  assert.notEqual(
    linkKey("https://example.com/a"),
    linkKey("https://example.com/b"),
  );
  assert.notEqual(
    linkKey("https://example.com/post?id=1"),
    linkKey("https://example.com/post?id=2"),
  );
  assert.equal(
    linkKey("https://x.com/a/status/1?s=20&t=abc"),
    "x.com/a/status/1",
  );
});

test("page metadata comes from the page itself, never invented", () => {
  const html = `<html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Agent platforms in practice">
    <meta property="og:site_name" content="Example Engineering">
    <meta property="article:section" content="AI">
    <meta name="keywords" content="agents, tooling, evaluation">
    <meta name="description" content="A tutorial on planner loops &amp; tools.">
  </head><body><p>${"Long enough paragraph about agent architectures. ".repeat(2)}</p></body></html>`;
  const meta = pageMetadata(html, "https://example.com/x");
  assert.equal(meta.title, "Agent platforms in practice");
  assert.equal(meta.site, "Example Engineering");
  assert.equal(meta.topic, "AI");
  assert.deepEqual(meta.tags, ["agents", "tooling", "evaluation"]);
  assert.match(meta.excerpt!, /planner loops & tools/);
  const empty = pageMetadata(
    "<html><body><p>short</p></body></html>",
    "https://example.com/y",
  );
  assert.equal(empty.title, undefined);
  assert.equal(empty.topic, undefined);
  assert.equal(empty.site, "example.com");
  assert.equal(decodeEntities("&#65;&#x42;&amp;"), "AB&");
});

test("reading a page keeps its verified destination and degrades to unreadable", async () => {
  const html =
    "<html><head><title>T</title><meta property='og:title' content='Resolved title'></head><body></body></html>";
  const readable = await readLinkPage("https://example.com/a", {
    get: async (url, _signal, onDestination) => {
      onDestination?.("https://example.com/a");
      return { body: html, finalUrl: "https://example.com/final" };
    },
  });
  assert.equal(readable.readable, true);
  assert.equal(readable.url, "https://example.com/final");
  assert.equal(readable.title, "Resolved title");
  const unreadable = await readLinkPage("https://example.com/blocked", {
    get: async () => {
      throw new Error("blocked");
    },
  });
  assert.equal(unreadable.readable, false);
  assert.equal(unreadable.url, "https://example.com/blocked");
  assert.equal(unreadable.title, undefined);
  assert.deepEqual(unreadable.tags, []);
  await assert.rejects(
    readLinkPage("http://localhost/x", {
      get: async () => ({ body: "", finalUrl: "http://localhost/x" }),
    }),
  );
});

test("the recorded reason states the evidence and the score", () => {
  const studying = linkReason(
    config,
    facts,
    linkDecision(config, answers("study", { study: 0.8, reader: 0.2 })),
  );
  assert.match(studying, /Building agent platforms/);
  assert.match(studying, /example\.com/);
  assert.match(studying, /80%/);
  assert.match(studying, /learning interests/);
  const cue = linkReason(
    config,
    { ...facts, ownerMessage: "for offline reading" },
    linkDecision(config, answers("reader", { study: 0.5, reader: 0.3 }, 0.9)),
    "for offline reading",
  );
  assert.match(cue, /You said "for offline reading"/);
  assert.match(cue, /Reader/);
  const unsure = linkReason(
    config,
    facts,
    linkDecision(config, answers("study", { study: 0.4, reader: 0.4 })),
  );
  assert.match(unsure, /asked/);
});
