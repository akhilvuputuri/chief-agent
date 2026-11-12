import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import type { ModelConfig } from "./types.js";

/** Names the request's purpose (agent turn or compaction summary) for the host's call record. */
export const purposeHeader = "x-runtime-purpose";

export type ModelFactory = () => Promise<{
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
  return async () => {
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
      streamSimple: (model, context, options) =>
        anthropicMessagesApi().streamSimple(model, context, {
          ...options,
          headers: { ...options?.headers, [purposeHeader]: requestPurpose },
        }),
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
