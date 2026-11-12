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
  | "auth"
  | "permission"
  | "billing"
  | "rate_limit"
  | "unavailable"
  | "not_found"
  | "rejected";
const FAULTS = new Set<string>([
  "auth",
  "permission",
  "billing",
  "rate_limit",
  "unavailable",
  "not_found",
  "rejected",
]);
/** A rejected request that will fail every direct call until the account is enrolled. */
const NOT_ENROLLED = "organization_not_enrolled_in_beta";
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
 * Faults that say nothing about other models, so they cool only the failing one. Anthropic
 * limits each model separately, so a rate limit on Haiku must not send Opus to OpenRouter
 * (journal 164).
 */
const MODEL_ONLY = new Set<ProviderFault>([
  "not_found",
  "permission",
  "rate_limit",
]);

/**
 * Per-process memory of a failing direct pathway, so a dead key or exhausted credits costs
 * one failed request per window rather than one on every call. Key, billing and
 * beta-enrollment faults apply to every model; a rate limit, an unknown model or a refused
 * (permission) model to that model only. An outage or an ordinary rejected request (400) falls back that call only.
 */
export class DirectCooldown {
  private until = new Map<string, { at: number; fault: ProviderFault }>();
  constructor(private now: () => number = Date.now) {}
  /** Seconds a fault keeps the direct pathway off; 0 falls back for that one call. */
  static seconds(
    fault: ProviderFault,
    retryAfter?: unknown,
    errorCode?: unknown,
  ) {
    if (fault === "unavailable") return 0;
    if (fault === "rejected") return errorCode === NOT_ENROLLED ? 600 : 0;
    if (fault !== "rate_limit") return 600;
    const hint =
      typeof retryAfter === "number" && Number.isFinite(retryAfter)
        ? retryAfter
        : 30;
    return Math.min(120, Math.max(5, Math.ceil(hint)));
  }
  /** Records a fault and returns its cooldown in seconds. */
  remember(
    model: string,
    fault: ProviderFault,
    retryAfter?: unknown,
    errorCode?: unknown,
  ) {
    const seconds = DirectCooldown.seconds(fault, retryAfter, errorCode);
    if (seconds > 0)
      this.until.set(MODEL_ONLY.has(fault) ? model : "*", {
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

/** One direct failure that fell back to OpenRouter: structural fields only, never provider text. */
export type FallbackNotice = {
  model: string;
  reason: ProviderFault;
  cooldownS: number;
  httpStatus?: unknown;
};

const REASONS: Record<ProviderFault, string> = {
  auth: "the API key was refused",
  permission: "the key may not use this model",
  billing: "a billing or credit limit was reached",
  rate_limit: "a rate limit was reached",
  unavailable: "Anthropic was unavailable",
  not_found: "the model was not found",
  rejected: "the request was rejected",
};

/**
 * Tells the owner when Chief falls back from Claude to OpenRouter, so a fallback is never silent
 * (owner request, 11 November 2026, journal 164). At most one message per fault an hour; the
 * next one counts the fallbacks it held back. `send` is set once Telegram is ready.
 */
export class FallbackAlerts {
  send: (text: string) => Promise<void> = async () => {};
  private last = new Map<string, { at: number; held: number }>();
  constructor(
    private now: () => number = Date.now,
    private intervalMs = 3_600_000,
  ) {}
  notice(n: FallbackNotice) {
    // Per fault and model: a rate limit cools one model, so another model's must still be told.
    const key = `${n.reason}:${n.model}`;
    const previous = this.last.get(key);
    if (previous && this.now() - previous.at < this.intervalMs) {
      previous.held++;
      return;
    }
    this.last.set(key, { at: this.now(), held: 0 });
    const status =
      typeof n.httpStatus === "number" ? ` (HTTP ${n.httpStatus})` : "";
    const retry = n.cooldownS
      ? `For the next ${Math.max(1, Math.round(n.cooldownS / 60))} min this model's calls go straight to OpenRouter.`
      : "The next call tries Claude directly again.";
    const held = previous?.held
      ? ` ${previous.held} more direct ${previous.held === 1 ? "attempt" : "attempts"} for this model failed the same way in the hour before.`
      : "";
    void this.send(
      `A direct Claude call failed: ${REASONS[n.reason]}${status}, model ${n.model}. Chief is retrying it through OpenRouter, which uses OpenRouter credit. ${retry}${held} To stop falling back, set "fallback": false in config/model-policy.json; to use OpenRouter for everything, set MODEL_PROVIDER to openrouter in config/runtime.json.`,
    ).catch(() => {});
  }
}

// Direct-produced reasoning is bound to the Anthropic account, so OpenRouter never gets it;
// OpenRouter's own entries stay, and messages without direct entries pass as the same objects.
const forOpenRouter = (messages: ModelMessage[]) =>
  stripAnthropicDirectReasoning(messages);

/**
 * Any model on OpenRouter. A conversation that used the direct route can continue on another
 * model too (a model switch, a tier, a judge reading history), so every OpenRouter call strips.
 */
export class StrippedOpenRouter implements ModelAdapter {
  constructor(
    readonly model: string,
    private inner: ModelAdapter,
  ) {}
  generate(input: Parameters<Generate>[0]) {
    const messages = forOpenRouter(input.messages);
    return this.inner.generate(
      messages === input.messages ? input : { ...input, messages },
    );
  }
}

/**
 * The direct Anthropic adapter with a one-call OpenRouter fallback for the same model. Only
 * a failure before any model output (a ModelError with providerFault) falls back, and never once
 * the caller has aborted, so no output is ever repeated. Progress can be: the direct adapter
 * reports progress on received wire bytes (pings included) before any output, so a caller may
 * see progress from the failed direct attempt and then from the fallback.
 */
export class FallbackAdapter implements ModelAdapter {
  constructor(
    readonly model: string,
    private direct: ModelAdapter,
    private openRouter: ModelAdapter | undefined,
    private cooldown: DirectCooldown = sharedCooldown,
    private onFallback?: (notice: FallbackNotice) => void,
  ) {}
  async generate(input: Parameters<Generate>[0]): Promise<Generation> {
    const cooling = this.openRouter && this.cooldown.active(this.model);
    if (cooling) return this.fallback(input, cooling, true);
    try {
      return await this.direct.generate(input);
    } catch (error) {
      const fault = providerFault(error);
      if (!fault || !this.openRouter || input.signal.aborted) throw error;
      const { diagnostics } = error as ModelError;
      const cooldownS = this.cooldown.remember(
        this.model,
        fault,
        diagnostics.retryAfterSeconds,
        diagnostics.errorCode,
      );
      // Structural fields only: no content, no key, no provider text. errorType and
      // errorCode are the API's enum values, already filtered by the adapter.
      opsLog("model.provider_fallback", "warn", {
        model: this.model,
        reason: fault,
        cooldownS,
        httpStatus: diagnostics.httpStatus,
        errorType: diagnostics.errorType,
        errorCode: diagnostics.errorCode,
      });
      try {
        this.onFallback?.({
          model: this.model,
          reason: fault,
          cooldownS,
          httpStatus: diagnostics.httpStatus,
        });
      } catch {
        // A failing notice never changes the call.
      }
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
  /** ANTHROPIC_WORKSPACE_ID: sent as anthropic-workspace-id when set (unscoped keys). */
  anthropicWorkspaceId?: string;
  /** The effective provider price ceilings (resolvePriceCeilings). */
  ceilings: { input: number; output: number };
  policy?: ModelPolicy;
  cooldown?: DirectCooldown;
  /** Called once for each direct failure that falls back (not for calls skipped in a cooldown). */
  onFallback?: (notice: FallbackNotice) => void;
  /** Test seams; production builds the real adapters. */
  openRouter?: (model: string) => ModelAdapter;
  anthropic?: (model: string, route: AnthropicRoute) => ModelAdapter;
};

/**
 * Chooses each model's provider. Anthropic models listed in the policy go direct when
 * MODEL_PROVIDER is anthropic and the key is set, and only while their list price fits the
 * ceilings that OpenRouter's max_price enforces. Everything else is the OpenRouter adapter,
 * with direct-route reasoning stripped. `model` stays the OpenRouter ID, so journals and settings see no difference.
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
  /** The direct Anthropic mapping a model is called through, or undefined if it goes to OpenRouter. */
  anthropicRoute(model: string): AnthropicRoute | undefined {
    return this.direct(model);
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
    if (!route) return new StrippedOpenRouter(model, this.openRouter(model));
    const direct = o.anthropic
      ? o.anthropic(model, route)
      : new AnthropicDirect(o.anthropicKey, {
          model,
          nativeModel: route.nativeModel,
          prices: route.prices,
          workspaceId: o.anthropicWorkspaceId ?? "",
        });
    if (!route.fallback) return direct;
    return new FallbackAdapter(
      model,
      direct,
      o.openRouterKey ? this.openRouter(model) : undefined,
      o.cooldown ?? sharedCooldown,
      o.onFallback,
    );
  }
}
