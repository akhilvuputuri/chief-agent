// Link classification (docs/links.md). When the owner shares a link to save, TypeSafe's Jev
// decision model judges whether it is study material or offline reading, from the page facts
// the host read, the owner's own words and their learning interests. It is model judgment,
// not a keyword rule: the host only bounds the inputs, checks the answer's shape and treats
// anything below the confidence bar, or any failure, as "unsure" so the owner is asked with
// buttons. It never falls back to Reader.
//
// The model id comes from config/decisions.json (readDecisionConfig), the same source the
// shadow decisions use, so Jev's snapshot has one source of truth. config/links.json holds
// only the questions and thresholds.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { readDecisionConfig } from "./shadow.js";
import type { Spending } from "./spending.js";

const text = z.string().min(1).max(2000);
const probability = z.number().min(0).max(1);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    timeoutMs: z.number().int().positive().max(10000),
    confident: probability,
    topicMin: probability,
    excerptChars: z.number().int().positive().max(4000),
    destination: z
      .object({ instructions: text, study: text, reader: text })
      .strict(),
    topic: z.object({ instructions: text, other: text }).strict(),
  })
  .strict();
export type LinkConfig = z.infer<typeof schema>;

export function readLinkConfig(
  url: URL = new URL("../config/links.json", import.meta.url),
): LinkConfig {
  try {
    return schema.parse(JSON.parse(readFileSync(url, "utf8")));
  } catch (error) {
    throw new Error("Invalid bundled link config", { cause: error });
  }
}

/** What the host read from the page. Every field is from the page itself, or null. */
export interface PageFacts {
  url: string;
  site: string;
  title: string | null;
  description: string | null;
  excerpt: string | null;
}

export type Destination = "study" | "reader";

export interface ClassifyInput {
  ownerMessage: string;
  page: PageFacts;
  interests: string[];
  /** An explicit owner cue Chief passed: skips the destination question. */
  explicit?: Destination;
}

export type Classification =
  | {
      ok: true;
      destination: Destination;
      confidence: number;
      by: "jev" | "owner";
      topic: string | null;
      reason: string;
      probabilities?: Record<string, number>;
    }
  | {
      ok: false;
      outcome: "unsure" | "timeout" | "failed" | "invalid" | "unconfigured";
      /** Jev's leaning when it answered, for the button card. */
      leaning?: Destination;
      confidence?: number;
      topic: string | null;
      reason: string;
      probabilities?: Record<string, number>;
    };

function clip(value: string | null, n: number) {
  if (!value) return null;
  const points = [...value];
  return points.length > n ? points.slice(0, n).join("") + "…" : value;
}

const round = (p: number) => Math.round(p * 100);

/** Bounded state: Jev sees page facts and the owner's words, never tool output or history. */
export function linkState(config: LinkConfig, input: ClassifyInput) {
  return {
    owner_message: clip(input.ownerMessage, 1000) ?? "",
    link: {
      url: input.page.url,
      site: input.page.site,
      title: clip(input.page.title, 300),
      description: clip(input.page.description, 500),
      excerpt: clip(input.page.excerpt, config.excerptChars),
    },
    learning_interests: input.interests.map((i) => clip(i, 100)!),
  };
}

export function linkQuestions(config: LinkConfig, input: ClassifyInput) {
  const questions: Record<string, unknown> = {};
  if (!input.explicit)
    questions.destination = {
      type: "choice",
      instructions: config.destination.instructions,
      criteria: {
        study: config.destination.study,
        reader: config.destination.reader,
      },
    };
  if (input.interests.length)
    questions.topic = {
      type: "choice",
      instructions: config.topic.instructions,
      criteria: {
        ...Object.fromEntries(
          input.interests.map((interest, i) => [
            `interest_${i + 1}`,
            clip(interest, 100),
          ]),
        ),
        other: config.topic.other,
      },
    };
  return questions;
}

/** The facts a reason may cite: what Jev was shown, never what it might have inferred. */
function seen(page: PageFacts) {
  const parts = [
    page.title ? `the title "${clip(page.title, 80)}"` : null,
    `the site ${page.site}`,
    page.description || page.excerpt ? "the page text" : null,
  ].filter(Boolean);
  return parts.join(", ");
}

export class LinkClassifier {
  readonly model: string;
  constructor(
    private key: string | undefined,
    readonly config: LinkConfig = readLinkConfig(),
    private transport: typeof fetch = fetch,
    model: string = readDecisionConfig().model,
  ) {
    this.model = model;
  }

  async classify(
    input: ClassifyInput,
    ledger?: Spending,
  ): Promise<Classification> {
    const questions = linkQuestions(this.config, input);
    const owner = (topic: string | null): Classification => ({
      ok: true,
      destination: input.explicit!,
      confidence: 1,
      by: "owner",
      topic,
      reason:
        input.explicit === "study"
          ? "You asked for the study list."
          : "You asked for Reader.",
    });
    // An explicit cue with no interests to match needs no model call at all.
    if (input.explicit && !Object.keys(questions).length) return owner(null);
    if (!this.key)
      return input.explicit
        ? owner(null)
        : {
            ok: false,
            outcome: "unconfigured",
            topic: null,
            reason: "Link classification is not configured.",
          };
    let charge: string | undefined;
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    let data: any;
    try {
      // Usage accounting never decides the classification; its failure is ignored.
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
          body: JSON.stringify({
            model: this.model,
            state: linkState(this.config, input),
            questions,
          }),
        },
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          await settle({ cost: 0 });
        return input.explicit
          ? owner(null)
          : {
              ok: false,
              outcome: "failed",
              topic: null,
              reason: "The link classifier did not answer.",
            };
      }
      data = await response.json();
      await settle(data?.usage);
    } catch (error) {
      return input.explicit
        ? owner(null)
        : {
            ok: false,
            outcome:
              (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
            topic: null,
            reason: "The link classifier did not answer in time.",
          };
    }
    const topic = this.topic(data?.answers?.topic, input.interests);
    if (input.explicit) return owner(topic);
    const choice = data?.answers?.destination?.choice;
    const raw = data?.answers?.destination?.probabilities;
    const p = raw?.[choice];
    if (
      (choice !== "study" && choice !== "reader") ||
      typeof p !== "number" ||
      !(p >= 0 && p <= 1)
    )
      return {
        ok: false,
        outcome: "invalid",
        topic,
        reason: "The link classifier gave no usable answer.",
      };
    const probabilities: Record<string, number> = {};
    for (const d of ["study", "reader"])
      if (typeof raw[d] === "number" && raw[d] >= 0 && raw[d] <= 1)
        probabilities[d] = Math.round(raw[d] * 10_000) / 10_000;
    const label = choice === "study" ? "study material" : "offline reading";
    if (p < this.config.confident)
      return {
        ok: false,
        outcome: "unsure",
        leaning: choice,
        confidence: p,
        topic,
        reason: `Not sure: leaning ${label} (${round(p)}%) from ${seen(input.page)}.`,
        probabilities,
      };
    return {
      ok: true,
      destination: choice,
      confidence: p,
      by: "jev",
      topic,
      reason: `Judged ${label} (${round(p)}%) from ${seen(input.page)}.`,
      probabilities,
    };
  }

  /** One of the owner's own interests, only when Jev picked it clearly; never invented. */
  private topic(answer: any, interests: string[]): string | null {
    const choice = answer?.choice;
    const p = answer?.probabilities?.[choice];
    const match = /^interest_(\d+)$/.exec(
      typeof choice === "string" ? choice : "",
    );
    const interest = match ? interests[Number(match[1]) - 1] : undefined;
    if (
      !interest ||
      typeof p !== "number" ||
      !(p >= this.config.topicMin && p <= 1)
    )
      return null;
    return clip(interest, 100);
  }
}
