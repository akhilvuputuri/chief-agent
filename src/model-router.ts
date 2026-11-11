import {
  ModelError,
  OpenRouter,
  type Generation,
  type ModelAdapter,
  type ModelMessage,
} from "./model.js";
import { AnthropicDirect, stripAnthropicDirectReasoning } from "./anthropic.js";
import {
  readModelPolicy,
  resolveAnthropicModel,
  type AnthropicRoute,
  type ModelPolicy,
} from "./model-policy.js";
import { opsLog } from "./ops-log.js";

export type ModelRoute = "anthropic-direct" | "openrouter";
export type ProviderFault =
  "auth" | "billing" | "rate_limit" | "unavailable" | "not_found";
const FAULTS = new Set<string>([
  "auth",
  "billing",
  "rate_limit",
  "unavailable",
  "not_found",
]);
type Generate = ModelAdapter["generate"];

/** The fault class of a direct failure that produced no output, else undefined. */
export function providerFault(error: unknown): ProviderFault | undefined {
  const fault =
    error instanceof ModelError ? error.diagnostics.providerFault : undefined;
  return typeof fault === "string" && FAULTS.has(fault)
    ? (fault as ProviderFault)
    : undefined;
}

/**
 * Per-process memory of a failing direct pathway, so a dead key or exhausted credits costs
 * one failed request per window rather than one on every call. Key, billing and rate-limit
 * faults apply to every model; an unknown model applies to that model only.
 */
export class DirectCooldown {
  private until = new Map<string, { at: number; fault: ProviderFault }>();
  constructor(private now: () => number = Date.now) {}
  /** Seconds a fault keeps the direct pathway off; 0 falls back for that one call. */
  static seconds(fault: ProviderFault, retryAfter?: unknown) {
    if (fault === "unavailable") return 0;
    if (fault !== "rate_limit") return 600;
    const hint =
      typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? retryAfter
        : 30;
    return Math.min(120, Math.max(5, Math.ceil(hint)));
  }
  /** Records a fault and returns its cooldown in seconds. */
  remember(model: string, fault: ProviderFault, retryAfter?: unknown) {
    const seconds = DirectCooldown.seconds(fault, retryAfter);
    if (seconds > 0)
      this.until.set(fault === "not_found" ? model : "*", {
        at: this.now() + seconds * 1000,
        fault,
      });
    return seconds;
  }
  /** The fault still holding the direct pathway off for this model, if any. */
  active(model: string): ProviderFault | undefined {
    for (const key of [model, "*"]) {
      const entry = this.until.get(key);
      if (!entry) continue;
      if (entry.at > this.now()) return entry.fault;
      this.until.delete(key);
    }
    return undefined;
  }
}
const sharedCooldown = new DirectCooldown();

// Direct-produced reasoning is bound to the Anthropic account, so OpenRouter never gets it;
// OpenRouter's own entries stay, and messages without direct entries pass as the same objects.
const forOpenRouter = (messages: ModelMessage[]) =>
  stripAnthropicDirectReasoning(messages);

/** An anthropic/* model on OpenRouter, after a conversation may have used the direct route. */
class StrippedOpenRouter implements ModelAdapter {
  constructor(
    readonly model: string,
    private inner: ModelAdapter,
  ) {}
  generate(input: Parameters<Generate>[0]) {
    return this.inner.generate({
      ...input,
      messages: forOpenRouter(input.messages),
    });
  }
}

/**
 * The direct Anthropic adapter with a one-call OpenRouter fallback for the same model. Only
 * a failure before any output (a ModelError with providerFault) falls back, and never once
 * the caller has aborted, so no output or progress is ever repeated.
 */
export class FallbackAdapter implements ModelAdapter {
  constructor(
    readonly model: string,
    private direct: ModelAdapter,
    private openRouter: ModelAdapter | undefined,
    private cooldown: DirectCooldown = sharedCooldown,
  ) {}
  async generate(input: Parameters<Generate>[0]): Promise<Generation> {
    const cooling = this.openRouter && this.cooldown.active(this.model);
    if (cooling) return this.fallback(input, cooling, true);
    try {
      return await this.direct.generate(input);
    } catch (error) {
      const fault = providerFault(error);
      if (!fault || !this.openRouter || input.signal.aborted) throw error;
      const cooldownS = this.cooldown.remember(
        this.model,
        fault,
        (error as ModelError).diagnostics.retryAfterSeconds,
      );
      // Structural fields only: no content, no key, no provider text.
      opsLog("model.provider_fallback", "warn", {
        model: this.model,
        reason: fault,
        cooldownS,
      });
      return this.fallback(input, fault, false);
    }
  }
  private async fallback(
    input: Parameters<Generate>[0],
    fault: ProviderFault,
    cooling: boolean,
  ): Promise<Generation> {
    const generation = await this.openRouter!.generate({
      ...input,
      messages: forOpenRouter(input.messages),
    });
    return {
      ...generation,
      usage: {
        ...generation.usage,
        fallback_from: "anthropic-direct",
        fallback_reason: fault,
        ...(cooling ? { fallback_cooldown: true } : {}),
      },
    };
  }
}

export type ModelRouterOptions = {
  provider: "openrouter" | "anthropic";
  openRouterKey: string;
  anthropicKey: string;
  /** The effective provider price ceilings (resolvePriceCeilings). */
  ceilings: { input: number; output: number };
  policy?: ModelPolicy;
  cooldown?: DirectCooldown;
  /** Test seams; production builds the real adapters. */
  openRouter?: (model: string) => ModelAdapter;
  anthropic?: (model: string, route: AnthropicRoute) => ModelAdapter;
};

/**
 * Chooses each model's provider. Anthropic models listed in the policy go direct when
 * MODEL_PROVIDER is anthropic and the key is set, and only while their list price fits the
 * ceilings that OpenRouter's max_price enforces. Everything else is the plain OpenRouter
 * adapter. `model` stays the OpenRouter ID, so journals and settings see no difference.
 */
export class ModelRouter {
  private policy: ModelPolicy;
  constructor(private options: ModelRouterOptions) {
    this.policy = options.policy ?? readModelPolicy();
  }
  private direct(model: string) {
    const o = this.options;
    if (o.provider !== "anthropic" || !o.anthropicKey) return undefined;
    const route = resolveAnthropicModel(model, this.policy);
    return route &&
      route.prices.input <= o.ceilings.input &&
      route.prices.output <= o.ceilings.output
      ? route
      : undefined;
  }
  route(model: string): ModelRoute {
    return this.direct(model) ? "anthropic-direct" : "openrouter";
  }
  private openRouter(model: string) {
    const o = this.options;
    return o.openRouter
      ? o.openRouter(model)
      : new OpenRouter(
          o.openRouterKey,
          model,
          o.ceilings.input,
          o.ceilings.output,
        );
  }
  modelFor(model: string): ModelAdapter {
    const o = this.options;
    const route = this.direct(model);
    if (!route) {
      const plain = this.openRouter(model);
      return model.startsWith("anthropic/")
        ? new StrippedOpenRouter(model, plain)
        : plain;
    }
    const direct = o.anthropic
      ? o.anthropic(model, route)
      : new AnthropicDirect(o.anthropicKey, {
          model,
          nativeModel: route.nativeModel,
          prices: route.prices,
        });
    if (!route.fallback) return direct;
    return new FallbackAdapter(
      model,
      direct,
      o.openRouterKey ? this.openRouter(model) : undefined,
      o.cooldown ?? sharedCooldown,
    );
  }
}
