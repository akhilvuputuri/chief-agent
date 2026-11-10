// Link classification on Jev (TypeSafe), the small fast model the repo already
// decides with. The model id comes from config/tool-picker.json, the one place
// the repo pins Jev, so a snapshot change lands once. The request pattern (state
// plus `choice` questions, a timeout, an `openrouter-jev` ledger charge and a
// typed failure instead of a throw) is the one in src/tool-picker.ts,
// src/shadow.ts and src/effort.ts. Chief's main model is untouched.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { spending } from "./spending.js";
import { readPickerConfig } from "./tool-picker.js";

export const LINK_ROUTES = ["study", "reader", "both", "unsure"] as const;
export type LinkRoute = (typeof LINK_ROUTES)[number];
export const LINK_TOPICS = [
  "applied-ai-engineering",
  "agent-platforms",
  "developer-tools",
  "voice-conversational-ai",
  "other",
] as const;
export type LinkTopic = (typeof LINK_TOPICS)[number];
export const LINK_KINDS = [
  "technical",
  "discussion",
  "news",
  "essay",
  "product",
  "other",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
/** Whether the owner's own words named the destination, as Jev reads them. */
export const LINK_CUES = ["explicit", "none"] as const;
export type LinkCue = (typeof LINK_CUES)[number];

const text = z.string().min(1).max(2000);
const probability = z.number().min(0).max(1);
const choices = <T extends readonly [string, ...string[]]>(names: T) =>
  z.object(
    Object.fromEntries(names.map((n) => [n, text])) as {
      [K in T[number]]: typeof text;
    },
  );

const schema = z
  .object({
    schemaVersion: z.literal(1),
    timeoutMs: z.number().int().positive(),
    apply: z
      .object({ minConfidence: probability, minTopicConfidence: probability })
      .strict(),
    limits: z
      .object({
        titleChars: z.number().int().positive(),
        excerptChars: z.number().int().positive(),
        messageChars: z.number().int().positive(),
        interestsChars: z.number().int().positive(),
        topicChars: z.number().int().max(200),
        reasonChars: z.number().int().max(600),
      })
      .strict(),
    question: z
      .object({
        instructions: text,
        criteria: choices(LINK_ROUTES),
        topic: z
          .object({ instructions: text, criteria: choices(LINK_TOPICS) })
          .strict(),
        kind: z
          .object({ instructions: text, criteria: choices(LINK_KINDS) })
          .strict(),
        cue: z
          .object({ instructions: text, criteria: choices(LINK_CUES) })
          .strict(),
      })
      .strict(),
    /** The owner's saved learning interests, used when memory holds none. */
    interests: z.array(text).min(1).max(12),
  })
  .strict();
export type LinkClassifierConfig = z.infer<typeof schema>;

export function readLinkClassifierConfig(
  url: URL = new URL("../config/link-classifier.json", import.meta.url),
): LinkClassifierConfig {
  try {
    return schema.parse(JSON.parse(readFileSync(url, "utf8")));
  } catch (error) {
    throw new Error("Invalid bundled link classifier config", { cause: error });
  }
}

/** What Jev sees: real page data plus the owner's own words. Untrusted input. */
export interface LinkJudgeInput {
  url: string;
  title: string | null;
  site: string;
  excerpt: string | null;
  /** The owner's message that came with the link. */
  message: string;
  interests: string[];
}

export type LinkJudgeResult =
  | {
      ok: true;
      route: LinkRoute;
      /** Jev's probability for `route`. */
      confidence: number;
      topic: LinkTopic | null;
      kind: LinkKind;
      /**
       * "explicit" only when the owner's words themselves said where it goes. It is what
       * lets an unreadable page still be saved where the owner asked, instead of asked
       * about, so a missing answer is treated as "none" (ask) rather than guessed.
       */
      cue: LinkCue;
      model: string | null;
    }
  | {
      ok: false;
      failure: "timeout" | "rejected" | "failed" | "invalid";
      httpStatus?: number;
    };

const clip = (value: string, n: number) => {
  const points = [...value];
  return points.length > n ? points.slice(0, n).join("") : value;
};

export class JevLinks {
  constructor(
    private key: string,
    readonly config: LinkClassifierConfig = readLinkClassifierConfig(),
    readonly model: string = readPickerConfig().model,
    private transport: typeof fetch = fetch,
  ) {}

  /** One decision request: the route, which learning interest it covers and the page's kind. */
  async judge(input: LinkJudgeInput): Promise<LinkJudgeResult> {
    const limits = this.config.limits;
    const ask = {
      model: this.model,
      state: {
        link: {
          url: clip(input.url, 2048),
          title: input.title ? clip(input.title, limits.titleChars) : null,
          site: clip(input.site, 120),
          excerpt: input.excerpt
            ? clip(input.excerpt, limits.excerptChars)
            : null,
        },
        owner_message: clip(input.message, limits.messageChars),
        learning_interests: clip(
          input.interests.join("; "),
          limits.interestsChars,
        ),
      },
      questions: {
        route: {
          type: "choice",
          instructions: this.config.question.instructions,
          criteria: this.config.question.criteria,
        },
        topic: {
          type: "choice",
          instructions: this.config.question.topic.instructions,
          criteria: this.config.question.topic.criteria,
        },
        kind: {
          type: "choice",
          instructions: this.config.question.kind.instructions,
          criteria: this.config.question.kind.criteria,
        },
        cue: {
          type: "choice",
          instructions: this.config.question.cue.instructions,
          criteria: this.config.question.cue.criteria,
        },
      },
    };
    const ledger = spending.getStore();
    let charge: string | undefined;
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    try {
      // Usage accounting never decides the route; its failures are ignored.
      charge = await ledger
        ?.begin("openrouter-jev", 0.001)
        .catch(() => undefined);
      const response = await this.transport(
        "https://openrouter.ai/api/alpha/decisions",
        {
          method: "POST",
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(ask),
        },
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          await settle({ cost: 0 });
        return {
          ok: false,
          failure: [401, 402, 403].includes(response.status)
            ? "rejected"
            : "failed",
          httpStatus: response.status,
        };
      }
      const data: any = await response.json();
      await settle(data?.usage);
      const route = data?.answers?.route;
      const chosen: unknown = route?.choice;
      const score: unknown = route?.probabilities?.[chosen as string];
      if (
        !LINK_ROUTES.includes(chosen as LinkRoute) ||
        typeof score !== "number" ||
        !(score >= 0 && score <= 1)
      )
        return { ok: false, failure: "invalid" };
      const topicAnswer = data?.answers?.topic;
      const topicChoice: unknown = topicAnswer?.choice;
      const topicScore: unknown =
        topicAnswer?.probabilities?.[topicChoice as string];
      const kindChoice: unknown = data?.answers?.kind?.choice;
      const cueChoice: unknown = data?.answers?.cue?.choice;
      return {
        ok: true,
        route: chosen as LinkRoute,
        confidence: score,
        topic:
          LINK_TOPICS.includes(topicChoice as LinkTopic) &&
          topicChoice !== "other" &&
          typeof topicScore === "number" &&
          topicScore >= this.config.apply.minTopicConfidence
            ? (topicChoice as LinkTopic)
            : null,
        kind: LINK_KINDS.includes(kindChoice as LinkKind)
          ? (kindChoice as LinkKind)
          : "other",
        // A missing or unrecognised answer is "no explicit cue": the owner is asked
        // rather than the destination being guessed.
        cue: cueChoice === "explicit" ? "explicit" : "none",
        model: typeof data?.model === "string" ? data.model : this.model,
      };
    } catch (error) {
      return {
        ok: false,
        failure:
          (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
      };
    }
  }
}

/** What the classifier needs from Jev: one judgment per shared link. */
export interface LinkJudge {
  judge(input: LinkJudgeInput): Promise<LinkJudgeResult>;
}
