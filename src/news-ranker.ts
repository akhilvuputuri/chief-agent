// Bulletin ranking with TypeSafe's Jev (journal 92). Once per edition, Jev answers one
// yes/no question per shortlisted candidate: would the owner save it, given their topics
// and recent Reader saves? Each candidate is its own request (several in parallel):
// measured reports show accuracy falls when one state holds many items. Candidates are
// then ordered by that probability. Any failure returns ok=false and the edition keeps
// the deterministic ranker's order, so Jev can never stop a bulletin.
// config/news-ranker.json holds the question and limits.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const text = z.string().min(1).max(2000);
const count = z.number().int().positive();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    model: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/),
    // "jev": Jev's probability orders the edition. "rrf": reciprocal-rank fusion of Jev's
    // order and the deterministic order, the blend the literature recommends with few labels.
    order: z.enum(["jev", "rrf"]),
    rrfK: count,
    // The exploration pick comes from the top of the active order, outside the regular picks.
    exploreWindow: count,
    // Per request; a timeout, 429 or 5xx is retried `retries` times.
    timeoutMs: count,
    retries: z.number().int().min(0).max(3),
    // Requests in flight at once, and the shortlist Jev scores (deterministic order).
    concurrency: count,
    maxCandidates: count,
    state: z
      .object({ recentSaves: count, titleChars: count, excerptChars: count })
      .strict(),
    question: z
      .object({ instructions: text, true: text, false: text })
      .strict(),
  })
  .strict();
export type NewsRankerConfig = z.infer<typeof schema>;

export function readNewsRankerConfig(
  url: URL = new URL("../config/news-ranker.json", import.meta.url),
): NewsRankerConfig {
  return schema.parse(JSON.parse(readFileSync(url, "utf8")));
}

export type RankInput = {
  topics: string[];
  /** Saved titles, most relevant first (by the profile's decayed weight). */
  saves: string[];
  candidates: {
    key: string;
    title: string;
    site: string;
    excerpt?: string;
    publishedAt?: Date;
  }[];
};

export type RankResult = {
  ok: boolean;
  /** Candidate key → Jev's probability that the owner would save it. */
  scores: Map<string, number>;
  asked: number;
  requests: number;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
  error?: string;
};

export class JevNewsRanker {
  /** Identifies the model, question and limits behind a logged ranking. */
  readonly version: string;
  constructor(
    private key: string,
    readonly config: NewsRankerConfig = readNewsRankerConfig(),
    private transport: typeof fetch = fetch,
  ) {
    this.version = createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex")
      .slice(0, 12);
  }

  /** Scores every candidate, or returns ok=false. Never throws. */
  async score(input: RankInput): Promise<RankResult> {
    const c = this.config;
    const started = Date.now();
    const shortlist = input.candidates.slice(0, c.maxCandidates);
    const profile = {
      owner_topics: input.topics.slice(0, 30),
      recent_saves: input.saves
        .slice(0, c.state.recentSaves)
        .map((t) => t.slice(0, c.state.titleChars)),
    };
    const question = {
      save: {
        type: "noul",
        instructions: c.question.instructions,
        criteria: { true: c.question.true, false: c.question.false },
      },
    };
    const scores = new Map<string, number>();
    let cost: number | null = 0;
    let model: string | null = null;
    let requests = 0;
    const done = (error?: string): RankResult => ({
      ok: !error,
      scores: error ? new Map() : scores,
      asked: shortlist.length,
      requests,
      latencyMs: Date.now() - started,
      costUsd: error ? null : cost,
      model,
      ...(error ? { error } : {}),
    });
    const ask = async (x: (typeof shortlist)[number]) => {
      for (let attempt = 0; ; attempt++) {
        requests++;
        const retry = attempt < c.retries;
        let response: Response;
        try {
          response = await this.transport(
            "https://openrouter.ai/api/alpha/decisions",
            {
              method: "POST",
              signal: AbortSignal.timeout(c.timeoutMs),
              headers: {
                Authorization: `Bearer ${this.key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: c.model,
                state: {
                  ...profile,
                  candidate: {
                    title: x.title.slice(0, c.state.titleChars),
                    site: x.site,
                    ...(x.excerpt
                      ? { excerpt: x.excerpt.slice(0, c.state.excerptChars) }
                      : {}),
                    ...(x.publishedAt
                      ? { published: x.publishedAt.toISOString().slice(0, 10) }
                      : {}),
                  },
                },
                questions: question,
              }),
            },
          );
        } catch (error) {
          if (retry && (error as Error)?.name === "TimeoutError") continue;
          throw error;
        }
        if (!response.ok) {
          if (retry && (response.status === 429 || response.status >= 500))
            continue;
          throw new RankError(`http_${response.status}`);
        }
        const data: any = await response.json();
        const p = data?.answers?.save?.noul;
        if (typeof p !== "number" || !(p >= 0 && p <= 1))
          throw new RankError("invalid");
        scores.set(x.key, Math.round(p * 10_000) / 10_000);
        const reported = data?.usage?.cost;
        // One unreported charge makes the total unknown, never zero.
        cost =
          cost === null ||
          typeof reported !== "number" ||
          !Number.isFinite(reported)
            ? null
            : cost + reported;
        model ??= typeof data?.model === "string" ? data.model : null;
        return;
      }
    };
    try {
      let next = 0;
      let failed: unknown;
      await Promise.all(
        Array.from(
          { length: Math.min(c.concurrency, shortlist.length) },
          async () => {
            while (next < shortlist.length && !failed) {
              const x = shortlist[next++]!;
              try {
                await ask(x);
              } catch (error) {
                failed ??= error;
              }
            }
          },
        ),
      );
      if (failed) throw failed;
      return done();
    } catch (error) {
      return done(
        error instanceof RankError
          ? error.message
          : (error as Error)?.name === "TimeoutError"
            ? "timeout"
            : "failed",
      );
    }
  }
}

class RankError extends Error {}
