// Executed only inside the existing trusted gateway container by the temporary
// acceptance broker. Credentials never leave readConfig/the provider client.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import { OpenRouter, ModelError } from "./dist/model.js";
import { readConfig } from "./dist/config.js";
const stop = new AbortController();
process.stdin.on("end", () => stop.abort());
const input = createInterface({ input: process.stdin });
const request = await new Promise((resolve, reject) => {
  input.once("line", resolve);
  input.once("close", () => reject(new Error("Input closed")));
});
let result,
  code = 0,
  dispatchAttempted = false;
try {
  const q = z
    .object({
      callId: z.string().uuid(),
      model: z.enum([
        "deepseek/deepseek-v4.1-flash",
        "openai/gpt-6.1-sol",
        "anthropic/claude-sonnet-5.5",
        "google/gemini-3.8-flash",
        "google/gemini-4-argon",
      ]),
      messages: z.array(z.unknown()).max(2048),
      tools: z.array(z.unknown()).max(12),
      maxOutputTokens: z.number().int().positive().max(16000),
      purpose: z.enum(["agent", "compaction"]),
      stream: z.literal(true),
      cacheKey: z.string().min(1).max(200),
    })
    .strict()
    .parse(JSON.parse(request));
  const config = readConfig();
  let lastProgress = 0;
  const generation = await new OpenRouter(
    config.OPENROUTER_API_KEY,
    q.model,
    config.OPENROUTER_MAX_INPUT_PRICE,
    config.OPENROUTER_MAX_OUTPUT_PRICE,
    (url, options) => {
      options?.signal?.throwIfAborted();
      dispatchAttempted = true;
      return fetch(url, options);
    },
  ).generate({
    messages: q.messages,
    tools: q.tools,
    reasoning: "high",
    requireComplete: true,
    stream: q.stream,
    cacheKey: q.cacheKey,
    onProgress: async (value) => {
      if (Date.now() - lastProgress < 1000) return;
      lastProgress = Date.now();
      await new Promise((resolve, reject) =>
        process.stdout.write(
          JSON.stringify({
            type: "progress",
            value: {
              bytes: value.bytes,
              responseId: value.responseId,
              provider: value.provider,
            },
          }) + "\n",
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    },
    maxOutputTokens: q.maxOutputTokens,
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(300000)]),
  });
  result = {
    generation,
    outcomeKnown: true,
    dispatchAttempted,
    billingUnknown: typeof generation.usage?.cost !== "number",
    accounting: {
      adapterSha: createHash("sha256")
        .update(readFileSync("./dist/model.js"))
        .digest("hex"),
      inputPriceFilter: config.OPENROUTER_MAX_INPUT_PRICE,
      outputPriceFilter: config.OPENROUTER_MAX_OUTPUT_PRICE,
      model: generation.model,
      provider: generation.provider,
      promptTokens: generation.usage?.prompt_tokens,
      completionTokens: generation.usage?.completion_tokens,
      costUsd: generation.usage?.cost,
      requestedOutputTokens: q.maxOutputTokens,
      purpose: q.purpose,
    },
  };
} catch (error) {
  code = 1;
  result = {
    failed: true,
    category: error instanceof ModelError ? "provider" : "adapter",
    diagnostics: error instanceof ModelError ? error.diagnostics : undefined,
    dispatchAttempted,
    transient: error instanceof ModelError && error.transient,
    outcomeKnown:
      !dispatchAttempted ||
      (error instanceof ModelError &&
        (Number.isInteger(error.diagnostics.httpStatus) ||
          error.diagnostics.failureCode === "incomplete")),
    billingUnknown: dispatchAttempted,
  };
}
process.stdout.write(
  JSON.stringify({ type: "result", value: result }) + "\n",
  () => process.exit(code),
);
