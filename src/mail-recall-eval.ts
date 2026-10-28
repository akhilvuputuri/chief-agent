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
// A question counts as found when the target message is among the results.
import { z } from "zod";
import { readConfig } from "./config.js";
import { GmailTools } from "./gmail.js";
import { MailIndex, OpenRouterEmbedder } from "./mail-recall.js";

const MODEL = "google/gemini-3.8-flash";
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
    return JSON.parse(text);
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
        temperature: 0.2,
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
  const wanted = Number(process.argv[2] ?? 30);
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
  const index = new MailIndex(
    gmail,
    new OpenRouterEmbedder(c.OPENROUTER_API_KEY),
    owner,
  );
  await index.start();
  if (index.state !== "ready") throw new Error("The mail index did not build");
  let cost = 0;
  // recallAlone: gmail_recall by itself; recallExtra: found by gmail_recall and not by keyword.
  const totals = {
    questions: 0,
    keyword: 0,
    recall: 0,
    recallAlone: 0,
    recallExtra: 0,
  };
  for (const m of shuffle(index.sample())) {
    if (totals.questions >= wanted) break;
    if (m.text.trim().length < 80) continue;
    const written = await ask(
      c.OPENROUTER_API_KEY,
      `Here is an email the owner received in the last year.\n\nFrom: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text.slice(0, 1200)}\n\nWrite one question the owner might ask an assistant to find this email weeks later, half-remembering what it was about. Describe its content in everyday words. Do not use the sender's name or organisation, the subject's words, or distinctive phrases from the email. If the email is an automated notice with nothing a person would look for again, answer {"skip": true}. Otherwise answer {"question": "..."}.`,
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
        )) as { results?: { id?: string }[] };
        for (const r of result.results ?? []) if (r.id) keywordIds.add(r.id);
      } catch {
        /* A failed search finds nothing. */
      }
    }
    const recalled = await index.recall(owner, question);
    const hits = "results" in recalled ? recalled.results : [];
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
      }),
    );
  }
  console.log(
    JSON.stringify({
      summary: true,
      indexedMessages: index.messages,
      ...totals,
      keywordRate: totals.questions ? totals.keyword / totals.questions : 0,
      recallRate: totals.questions ? totals.recall / totals.questions : 0,
      recallAloneRate: totals.questions
        ? totals.recallAlone / totals.questions
        : 0,
      modelCostUsd: Math.round(cost * 10000) / 10000,
    }),
  );
}

await main();
