// Link routing: Jev, the TypeSafe decision model the picker and effort picker already use,
// judges where an owner's shared link belongs. The model id, timeout and question text come
// from config/decisions.json, so there is one source of truth and no second provider or model.
// Jev's judgement decides; the host validates its answer and treats every failure as unsure.
// Nothing here is a keyword or rule classifier: an explicit owner cue wins because Jev is told
// so and reads the message, not because this file matches words.
import type { Spending } from "./spending.js";
import { readDecisionConfig, type DecisionConfig } from "./decision-config.js";

export const LINK_ROUTES = ["study", "reader", "both"] as const;
export type LinkRoute = (typeof LINK_ROUTES)[number];
export const LINK_TOPICS = [
  "applied-ai-engineering",
  "agent-platforms",
  "developer-tools",
  "voice-conversational-ai",
  "other",
] as const;
export type LinkTopic = (typeof LINK_TOPICS)[number];

export type LinkEvidence = {
  /** The link as shared, after the public-HTTPS and canonical guard. */
  url: string;
  /** The verified page, when resolution changed the address. */
  pageUrl: string;
  site: string;
  title: string;
  description?: string;
  /** The post's own text, when the page exposes it (X/Twitter oEmbed). */
  postText?: string;
};

export type LinkClassifyInput = {
  /** The owner's message(s) that carried the link, clipped by the caller. */
  ownerMessage: string;
  link: LinkEvidence;
  /** Titles and sites of the owner's last few saves, for continuity only. */
  recent?: { title: string; site: string }[];
};

export type LinkClassification = {
  ok: boolean;
  /** A route, or "unsure" when Chief must ask with tap options. */
  route: LinkRoute | "unsure";
  topic: LinkTopic;
  /** Why, in the host's words, from Jev's own probabilities. Never page text. */
  reason: string;
  /** Jev's probability for the chosen route; 0 when it is absent or invalid. */
  confidence: number;
  /** Jev's probability that the link is genuinely hard to place. */
  unsure: number;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
  error?: string;
};

const clip = (value: string, max: number) => {
  const points = [...value];
  return points.length > max ? points.slice(0, max).join("") : value;
};
const probability = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1
    ? Math.round(value * 10_000) / 10_000
    : undefined;
const topics = new Set<string>(LINK_TOPICS);
const routes = new Set<string>(LINK_ROUTES);

export class LinkRouter {
  constructor(
    private key: string,
    readonly config: DecisionConfig = readDecisionConfig(),
    private transport: typeof fetch = fetch,
  ) {}

  /**
   * One classification. Never throws: a malformed, timed-out, refused or unreachable answer
   * becomes "unsure", so the owner gets tap options and neither store is written.
   */
  async classify(
    input: LinkClassifyInput,
    ledger?: Spending,
  ): Promise<LinkClassification> {
    const started = Date.now();
    const failed = (error: string): LinkClassification => ({
      ok: false,
      route: "unsure",
      topic: "other",
      reason: "Chief could not judge where this belongs, so nothing was saved.",
      confidence: 0,
      unsure: 1,
      latencyMs: Date.now() - started,
      costUsd: null,
      model: null,
      error,
    });
    let charge: string | undefined;
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    try {
      charge = await ledger
        ?.begin("openrouter-jev", 0.001)
        .catch(() => undefined);
      const links = this.config.links;
      const response = await this.transport(
        "https://openrouter.ai/api/alpha/decisions",
        {
          method: "POST",
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            state: {
              owner_message: clip(input.ownerMessage, 2000),
              owner_interests: links.interests,
              explicit_cue_rule: links.explicitCues,
              link: {
                url: input.link.url,
                page_url: input.link.pageUrl,
                site: input.link.site,
                title: input.link.title,
                kind: input.link.postText
                  ? "post"
                  : input.link.description
                    ? "page"
                    : "link",
                ...(input.link.description
                  ? { description: clip(input.link.description, 600) }
                  : {}),
                ...(input.link.postText
                  ? { post_text: clip(input.link.postText, 600) }
                  : {}),
              },
              ...(input.recent?.length
                ? {
                    recent_saves: input.recent.slice(-5).map((r) => ({
                      title: clip(r.title, 200),
                      site: clip(r.site, 100),
                    })),
                  }
                : {}),
            },
            questions: {
              route: {
                type: "choice",
                instructions: links.route.instructions,
                criteria: links.route.criteria,
              },
              topic: {
                type: "choice",
                instructions: links.topic.instructions,
                criteria: links.topic.criteria,
              },
              unsure: {
                type: "noul",
                instructions: links.unsure.instructions,
                criteria: links.unsure.criteria,
              },
            },
          }),
        },
      );
      if (!response.ok) {
        // A definite client-side rejection is not billed; server errors stay estimated.
        if (response.status >= 400 && response.status < 500)
          await settle({ cost: 0 });
        return failed(`http_${response.status}`);
      }
      const data: any = await response.json();
      await settle(data?.usage);
      const answers = data?.answers;
      const choice = answers?.route?.choice;
      const routeProbability = probability(
        answers?.route?.probabilities?.[choice],
      );
      const unsure = probability(answers?.unsure?.noul);
      // Every offered label is validated: a made-up route or a missing probability is not
      // evidence, so Chief asks instead of guessing.
      if (
        typeof choice !== "string" ||
        !routes.has(choice) ||
        routeProbability === undefined ||
        unsure === undefined
      )
        return failed("invalid");
      const topicChoice = answers?.topic?.choice;
      const topic =
        typeof topicChoice === "string" && topics.has(topicChoice)
          ? (topicChoice as LinkTopic)
          : "other";
      const route: LinkRoute | "unsure" =
        unsure >= this.config.links.apply.unsure ||
        routeProbability < this.config.links.apply.confidence
          ? "unsure"
          : (choice as LinkRoute);
      const others = LINK_ROUTES.filter((r) => r !== choice)
        .map((r) => {
          const p = probability(answers?.route?.probabilities?.[r]);
          return p === undefined ? null : `${r} ${p.toFixed(2)}`;
        })
        .filter(Boolean)
        .join(", ");
      const reason = clip(
        route === "unsure"
          ? `Jev was not confident enough (${choice} ${routeProbability.toFixed(2)}, unsure ${unsure.toFixed(2)}).`
          : `Jev chose ${choice} at ${routeProbability.toFixed(2)} (${others}); topic ${topic}.`,
        300,
      );
      const cost = data?.usage?.cost;
      return {
        ok: true,
        route,
        topic,
        reason,
        confidence: routeProbability,
        unsure,
        latencyMs: Date.now() - started,
        costUsd:
          typeof cost === "number" && Number.isFinite(cost) ? cost : null,
        model: typeof data?.model === "string" ? data.model : null,
      };
    } catch (error) {
      return failed(
        (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
      );
    }
  }
}
