// Operator-run retrieval eval for the email memory MVP (docs/mail-recall.md). Run inside the
// production gateway container with `docker exec`, so its output goes to the operator's
// terminal and never to the container log. It prints private per-question lines and a final
// summary line; keep the output in the private operations folder, never in the repository.
//
//   node dist/mail-recall-eval.js [questions]        (default 30)
//
// For each sampled email a model writes a question the owner might ask while half-remembering
// it, without the subject's or sender's words. Two retrieval conditions are compared:
//   keyword: up to three Gmail searches a model writes for the question (today's email agent)
//   recall:  the same searches plus gmail_recall's top results (the agent with both tools)
// A question counts as found when the target message is among the results. It only reads the
// stored index, which it shares with the running gateway. Email text comes from Gmail.
import { z } from "zod";
import { readConfig } from "./config.js";
import { connect } from "./db.js";
import { GmailTools } from "./gmail.js";
import { MailIndexStore } from "./mail-index-store.js";
import {
  chunks,
  MAIL_INDEX_DAY_MS,
  MAIL_INDEX_DAYS,
  MAIL_RECALL_RESULTS,
  OpenRouterEmbedder,
} from "./mail-recall.js";

const MODEL = "anthropic/claude-haiku-5.5";
/** The index's own Gmail read pace (src/mail-recall.ts), which leaves quota for the agent. */
const READ_INTERVAL_MS = 500;
/** A refused read waits for the per-minute quota to renew. A lost message would shift ranks. */
const READ_RETRY_MS = 60_000;
const READ_RETRIES = 3;
const QUOTA_REFUSED = /\((403|429)\)/;
/** Consecutive unreadable messages that mean something larger is wrong, such as a revoked token. */
const UNREADABLE_LIMIT = 5;
const STOP = new Set(
  "the and for you your with from this that have has are was were our not but all any can will about re fwd fw".split(
    " ",
  ),
);

function content(text: string) {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
      (w) => !STOP.has(w),
    ),
  );
}

/** A malformed model reply is treated as no answer, so one bad reply cannot end the run. */
function parse(text: string): unknown {
  try {
    // Claude models may wrap JSON in a code fence; json_object mode is not guaranteed for them.
    return JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    return {};
  }
}

async function ask(key: string, prompt: string) {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        // No temperature: Claude 5.5 models refuse any value but the default.
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok)
    throw new Error(`Model request failed (${response.status})`);
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { cost?: number };
  };
  return {
    value: parse(body.choices?.[0]?.message?.content ?? "{}"),
    cost: body.usage?.cost ?? 0,
  };
}

function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

async function main() {
  const count = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const wanted = count === undefined ? 30 : Number(count);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > 200)
    throw new Error("The question count must be a whole number from 1 to 200");
  // --export also writes the dataset evals/mail-recall/run.py reads: every chunk's text and
  // each question's ranked Gmail results and chunk scores. It contains email text: keep it
  // in the private operations folder only.
  const exporting = process.argv.includes("--export");
  const c = readConfig();
  if (
    !c.GMAIL_OWNER_USER_ID ||
    !c.GOOGLE_REFRESH_TOKEN ||
    !c.OPENROUTER_API_KEY
  )
    throw new Error("Gmail and OpenRouter must be configured");
  const owner = c.GMAIL_OWNER_USER_ID;
  const gmail = new GmailTools({
    owner,
    email: c.GMAIL_EMAIL,
    clientId: c.GOOGLE_CLIENT_ID,
    clientSecret: c.GOOGLE_CLIENT_SECRET,
    refreshToken: c.GOOGLE_REFRESH_TOKEN,
  });
  const embedder = new OpenRouterEmbedder(c.OPENROUTER_API_KEY);
  const db = connect(c.DATABASE_URL);
  const store = new MailIndexStore(db);
  const stored = await store.headers(owner);
  if (!stored.size) throw new Error("The mail index is empty");
  const since = Date.now() - MAIL_INDEX_DAYS * MAIL_INDEX_DAY_MS;
  let cost = 0;
  // recallAlone: gmail_recall by itself; recallExtra: found by gmail_recall and not by keyword.
  const totals = {
    questions: 0,
    keyword: 0,
    recall: 0,
    recallAlone: 0,
    recallExtra: 0,
  };
  for (const m of shuffle([...stored.values()])) {
    if (totals.questions >= wanted) break;
    const text = await gmail
      .indexMessage(owner, m.messageId)
      .then((message) => chunks(message)[0]?.text ?? "")
      .catch(() => "");
    if (text.trim().length < 80) continue;
    const written = await ask(
      c.OPENROUTER_API_KEY,
      `Here is an email the owner received in the last year.\n\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${text.slice(0, 1200)}\n\nWrite one question the owner might ask an assistant to find this email weeks later, half-remembering what it was about. Describe its content in everyday words. Do not use the sender's name or organisation, the subject's words, or distinctive phrases from the email. If the email is an automated notice with nothing a person would look for again, answer {"skip": true}. Otherwise answer {"question": "..."}.`,
    );
    cost += written.cost;
    const q = z
      .object({ question: z.string().min(8).max(300) })
      .safeParse(written.value);
    if (!q.success) continue;
    const question = q.data.question;
    // Keep only questions that do not reuse the subject's or sender's words.
    const words = content(question);
    const subject = [...content(m.subject)].filter((w) => words.has(w));
    const sender = [...content(m.from)].filter((w) => words.has(w));
    if (subject.length >= 2 || sender.length) continue;
    const planned = await ask(
      c.OPENROUTER_API_KEY,
      `You search the owner's Gmail for one email. The email arrived in the last year. Request: "${question}"\n\nWrite up to three Gmail search queries, most promising first. Anchor on the strongest clue with operators such as from:, subject:, quoted phrases, OR, -term, newer_than:, has:attachment, in:anywhere. Answer {"queries": ["..."]}.`,
    );
    cost += planned.cost;
    const queries = z
      .object({ queries: z.array(z.string().min(1).max(500)).max(3) })
      .safeParse(planned.value);
    // A malformed or empty plan says nothing about keyword search; skip the question.
    if (!queries.success || !queries.data.queries.length) continue;
    const keywordIds = new Set<string>();
    const keywordLists: string[][] = [];
    // Gmail's own headers and short snippet for each hit, so a re-ranker has some text for
    // hits outside the index (other categories, or older than the window).
    const keywordMeta: Record<string, Record<string, string | undefined>> = {};
    for (const [i, query] of (queries.success
      ? queries.data.queries
      : []
    ).entries()) {
      try {
        const result = (await gmail.call(
          owner,
          "gmail_search",
          query,
          undefined,
          `mail-eval-${totals.questions}-${i}`,
        )) as { results?: Record<string, string | undefined>[] };
        const ids = (result.results ?? []).flatMap((r) => (r.id ? [r.id] : []));
        // A hit whose metadata fetch failed arrives ID-only; a later search may fill it in.
        for (const r of result.results ?? [])
          if (r.id) {
            const meta = (keywordMeta[r.id] ??= {});
            for (const field of ["from", "subject", "date", "snippet"])
              meta[field] ||= r[field];
          }
        keywordLists.push(ids);
        for (const id of ids) keywordIds.add(id);
      } catch {
        /* A failed search finds nothing. */
        keywordLists.push([]);
      }
    }
    const [vector] = await embedder.embed([question.slice(0, 2000)]);
    const hits = (await store.search(owner, vector!, since)).slice(
      0,
      MAIL_RECALL_RESULTS,
    );
    const recallIds = new Set(hits.map((r) => r.messageId));
    const keyword = keywordIds.has(m.messageId);
    const recall = keyword || recallIds.has(m.messageId);
    totals.questions += 1;
    if (keyword) totals.keyword += 1;
    if (recall) totals.recall += 1;
    if (recallIds.has(m.messageId)) totals.recallAlone += 1;
    if (!keyword && recallIds.has(m.messageId)) totals.recallExtra += 1;
    // Private line: question and target subject, for the operator's review only.
    console.log(
      JSON.stringify({
        question,
        target: { messageId: m.messageId, subject: m.subject, date: m.date },
        queries: queries.success ? queries.data.queries : [],
        keyword,
        recall,
        recallRank:
          hits.findIndex((r) => r.messageId === m.messageId) + 1 || null,
        ...(exporting
          ? {
              type: "question",
              keywordLists,
              keywordMeta,
              dense: Object.fromEntries(
                (await store.scoreChunks(owner, vector!)).map((s) => [
                  `${s.messageId}:${s.chunk}`,
                  Math.round(s.score * 1e6) / 1e6,
                ]),
              ),
            }
          : {}),
      }),
    );
  }
  // Chunk text is not stored, so it is read again from Gmail at the index's own pace.
  let unreadable = 0;
  let consecutive = 0;
  if (exporting)
    for (const m of stored.values()) {
      await new Promise((resolve) => setTimeout(resolve, READ_INTERVAL_MS));
      let message: Awaited<ReturnType<typeof gmail.indexMessage>> | undefined;
      for (let tries = 0; !message && tries <= READ_RETRIES; tries++) {
        if (tries)
          await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
        const read = await gmail.indexMessage(owner, m.messageId).then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        message = read.value;
        if (!QUOTA_REFUSED.test(String((read.error as Error)?.message))) break;
      }
      consecutive = message ? 0 : consecutive + 1;
      if (consecutive >= UNREADABLE_LIMIT)
        throw new Error("Gmail refused too many reads in a row");
      if (!message) unreadable += 1;
      for (const [n, part] of (message ? chunks(message) : []).entries())
        console.log(
          JSON.stringify({
            type: "chunk",
            chunkId: `${m.messageId}:${n}`,
            ...m,
            text: part.text,
          }),
        );
    }
  console.log(
    JSON.stringify({
      summary: true,
      indexedMessages: stored.size,
      ...(exporting ? { unreadable } : {}),
      ...totals,
      keywordRate: totals.questions ? totals.keyword / totals.questions : 0,
      recallRate: totals.questions ? totals.recall / totals.questions : 0,
      recallAloneRate: totals.questions
        ? totals.recallAlone / totals.questions
        : 0,
      modelCostUsd: Math.round(cost * 10000) / 10000,
    }),
  );
  await db.end();
}

await main();
