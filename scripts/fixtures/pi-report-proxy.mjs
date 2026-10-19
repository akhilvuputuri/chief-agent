import { readFileSync } from "node:fs";
import { OpenRouter, ModelError } from "./dist/model.js";
import { readConfig } from "./dist/config.js";
import { resolvePriceCeilings } from "./dist/model-policy.js";
const q = JSON.parse(readFileSync(0, "utf8")),
  c = readConfig(),
  ceilings = resolvePriceCeilings({
    input: c.OPENROUTER_MAX_INPUT_PRICE,
    output: c.OPENROUTER_MAX_OUTPUT_PRICE,
  });
const allowed = [
  "deepseek/deepseek-v4.1-flash",
  "openai/gpt-6.1-sol",
  "anthropic/claude-sonnet-5.5",
  "google/gemini-3.8-flash",
  "google/gemini-4-argon",
];
try {
  if (!allowed.includes(q.model))
    throw Error("Model not selected for acceptance");
  const r = await new OpenRouter(
    c.OPENROUTER_API_KEY,
    q.model,
    ceilings.input,
    ceilings.output,
  ).generate({
    messages: q.messages,
    tools: q.tools,
    reasoning: "high",
    cacheKey: q.cacheKey,
    requireComplete: true,
    maxOutputTokens: 16000,
    signal: AbortSignal.timeout(q.stream ? 300000 : 120000),
    stream: q.stream === true,
    onProgress: q.stream
      ? (progress) => console.log(JSON.stringify({ progress }))
      : undefined,
  });
  console.log(
    JSON.stringify({
      generation: r,
      accounting: {
        model: r.model,
        provider: r.provider,
        promptTokens: r.usage?.prompt_tokens,
        completionTokens: r.usage?.completion_tokens,
        costUsd: r.usage?.cost,
      },
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      failed: true,
      category: e instanceof ModelError ? "provider" : "adapter",
      diagnostics: e instanceof ModelError ? e.diagnostics : undefined,
      billingUnknown: true,
    }),
  );
  process.exitCode = 1;
}
