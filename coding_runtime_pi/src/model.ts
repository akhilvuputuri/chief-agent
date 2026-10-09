import { randomUUID } from "node:crypto";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import type { ModelConfig } from "./types.js";

export type ModelFactory = (
  admit: () => Promise<void>,
) => Promise<{
  runtime: ModelRuntime;
  model: Model<any>;
  reasoning?: ModelConfig["reasoning"];
}>;
/** Native Pi OpenAI-compatible implementation; no custom transcript conversion. */
export function compatibleModel(config: ModelConfig): ModelFactory {
  return async (admit) => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const known = runtime.getModel(config.provider, config.model);
    const provider = "runtime";
    runtime.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: config.baseUrl ?? known?.baseUrl,
      models: [
        {
          id: config.model,
          name: config.model,
          input: ["text"],
          reasoning: known?.reasoning ?? true,
          cost: known?.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: config.contextWindow ?? known?.contextWindow ?? 32000,
          maxTokens: config.maxTokens ?? known?.maxTokens ?? 4096,
          compat: {
            ...known?.compat,
            supportsStore: false,
            supportsDeveloperRole: false,
          },
        },
      ],
      streamSimple: (model, context, options) => {
        const stream = openAICompletionsApi().streamSimple;
        // Admission is awaited before provider I/O, including compaction calls.
        const resultStream = new DeferredAdmissionStream(async () => {
          await admit();
          return stream(model, context, {
            ...options,
            onPayload: async (payload, selected) => {
              const original = await options?.onPayload?.(payload, selected);
              const request = original ?? payload;
              if (
                config.maxRequestBytes &&
                Buffer.byteLength(JSON.stringify(request)) >
                  config.maxRequestBytes
              )
                throw new Error("context_length_exceeded");
              return config.requestIdField
                ? {
                    ...(request as Record<string, unknown>),
                    [config.requestIdField]: randomUUID(),
                  }
                : request;
            },
          });
        });
        return resultStream.stream;
      },
    });
    if (config.apiKey) await runtime.setRuntimeApiKey(provider, config.apiKey);
    return {
      runtime,
      model: runtime.getModel(provider, config.model)!,
      reasoning: config.reasoning ?? "high",
    };
  };
}
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
class DeferredAdmissionStream {
  readonly stream = createAssistantMessageEventStream();
  constructor(start: () => Promise<AssistantMessageEventStream>) {
    void (async () => {
      try {
        for await (const event of await start()) this.stream.push(event);
      } catch {
        this.stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: "openai-completions",
            provider: "runtime",
            model: "unavailable",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            errorMessage: "Model request unavailable or allocation exhausted",
            timestamp: Date.now(),
          },
        });
      }
    })();
  }
}
