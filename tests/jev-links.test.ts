import test from "node:test";
import assert from "node:assert/strict";
import { JevLinks, readLinkClassifierConfig } from "../src/jev.js";
import { readPickerConfig } from "../src/tool-picker.js";

const config = readLinkClassifierConfig();
const input = {
  url: "https://example.org/agents",
  title: "Building agent architectures that hold up",
  site: "Example Engineering",
  excerpt: "A practical walkthrough of tool-using agent architectures.",
  message: "save this for AI learning",
  interests: config.interests,
};
const answer = (
  route: string,
  probabilities: Record<string, number>,
  topic: [string, number] = ["agent-platforms", 0.8],
  kind: [string, number] = ["technical", 0.7],
) => ({
  model: "typesafe/jev-1.13-20260917",
  usage: { cost: 0.00004 },
  answers: {
    route: { choice: route, probabilities },
    topic: {
      choice: topic[0],
      probabilities: { [topic[0]]: topic[1], other: 1 - topic[1] },
    },
    kind: {
      choice: kind[0],
      probabilities: { [kind[0]]: kind[1], other: 1 - kind[1] },
    },
  },
});

const respond = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("the Jev client asks one decision with the pinned model and a choice question per axis", async () => {
  const requests: { url: string; body: any }[] = [];
  const transport = (async (url: string, init: any) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify(answer("study", { study: 0.9, reader: 0.1 })),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const judge = new JevLinks(
    "test-key",
    config,
    "typesafe/jev-1.13-20260917",
    transport,
  );
  const result = await judge.judge(input);
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://openrouter.ai/api/alpha/decisions");
  // The model id has one source of truth: config/tool-picker.json.
  assert.equal(requests[0]!.body.model, readPickerConfig().model);
  assert.deepEqual(Object.keys(requests[0]!.body.questions), [
    "route",
    "topic",
    "kind",
  ]);
  for (const question of Object.values<any>(requests[0]!.body.questions))
    assert.equal(question.type, "choice");
  assert.equal(
    requests[0]!.body.state.owner_message,
    "save this for AI learning",
  );
  assert.equal(
    requests[0]!.body.state.link.title,
    "Building agent architectures that hold up",
  );
});

test("a timeout, a refusal and an unparseable answer are typed failures, never a Reader fallback", async () => {
  const failing = (error: Error) =>
    (async () => {
      throw error;
    }) as unknown as typeof fetch;
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.deepEqual(
    await new JevLinks("k", config, "m", failing(timeout)).judge(input),
    { ok: false, failure: "timeout" },
  );
  assert.deepEqual(
    await new JevLinks("k", config, "m", failing(new Error("offline"))).judge(
      input,
    ),
    { ok: false, failure: "failed" },
  );
  const forbidden = (async () =>
    new Response("{}", { status: 403 })) as unknown as typeof fetch;
  assert.deepEqual(
    await new JevLinks("k", config, "m", forbidden).judge(input),
    {
      ok: false,
      failure: "rejected",
      httpStatus: 403,
    },
  );
  const malformed = (async () =>
    new Response(JSON.stringify({ answers: { route: { choice: "study" } } }), {
      status: 200,
    })) as unknown as typeof fetch;
  assert.deepEqual(
    await new JevLinks("k", config, "m", malformed).judge(input),
    {
      ok: false,
      failure: "invalid",
    },
  );
});

test("a weak topic answer is omitted instead of stretched, and the classifier config has no model id", () => {
  assert.equal("model" in config, false);
  const transport = respond(answer("study", { study: 0.91 }, ["other", 0.2]));
  return new JevLinks("k", config, "m", transport)
    .judge(input)
    .then((result) => {
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.route, "study");
      assert.equal(result.confidence, 0.91);
      assert.equal(result.topic, null);
      assert.equal(result.kind, "technical");
      assert.equal(result.model, "typesafe/jev-1.13-20260917");
    });
});
