import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelConfig } from "./types.js";

/** Names the request's purpose (agent turn or compaction summary) for the host's call record. */
export const purposeHeader = "x-runtime-purpose";

export type ModelFactory = (admit: () => Promise<void>) => Promise<{
  runtime: ModelRuntime;
  model: Model<any>;
  reasoning?: ModelConfig["reasoning"];
  retry?: ModelConfig["retry"];
  setRequestPurpose?: (purpose: "agent" | "compaction") => void;
}>;

/**
 * Pi's own Anthropic Messages client, pointed at a gateway. Pi builds, streams and replays
 * every request exactly as it would against api.anthropic.com; only the address, the key
 * (a gateway capability, never an Anthropic key inside the box) and the purpose header differ.
 */
export function anthropicModel(config: ModelConfig): ModelFactory {
  return async (admit) => {
    let requestPurpose: "agent" | "compaction" = "agent";
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const known = runtime.getModel("anthropic", config.model);
    if (!known || known.api !== "anthropic-messages")
      throw new Error(`Pi's catalogue has no Anthropic model ${config.model}`);
    const provider = "runtime";
    runtime.registerProvider(provider, {
      api: "anthropic-messages",
      baseUrl: config.baseUrl ?? known.baseUrl,
      models: [
        {
          id: known.id,
          name: known.name,
          input: known.input,
          reasoning: known.reasoning,
          thinkingLevelMap: known.thinkingLevelMap,
          promptCache: known.promptCache,
          inputLimits: known.inputLimits,
          cost: known.cost,
          contextWindow: config.contextWindow ?? known.contextWindow,
          maxTokens: config.maxTokens ?? known.maxTokens,
          compat: known.compat,
        },
      ],
      streamSimple: (model, context, options) => {
        const purpose = requestPurpose;
        const stream = anthropicMessagesApi().streamSimple;
        // Admission is awaited before provider I/O, including compaction calls.
        return new DeferredAdmissionStream(model, async () => {
          await admit();
          return stream(model, context, {
            ...options,
            headers: { ...options?.headers, [purposeHeader]: purpose },
          });
        }).stream;
      },
    });
    if (config.apiKey) await runtime.setRuntimeApiKey(provider, config.apiKey);
    return {
      runtime,
      model: runtime.getModel(provider, known.id)!,
      reasoning: config.reasoning ?? "high",
      ...(config.retry ? { retry: config.retry } : {}),
      setRequestPurpose: (purpose) => {
        requestPurpose = purpose;
      },
    };
  };
}

class DeferredAdmissionStream {
  readonly stream = createAssistantMessageEventStream();
  constructor(
    model: Model<any>,
    start: () => Promise<AssistantMessageEventStream>,
  ) {
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
            api: model.api,
            provider: model.provider,
            model: model.id,
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
