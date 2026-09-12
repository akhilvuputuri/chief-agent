import type { Database } from "./db.js";
import type { Answer, RecordRef } from "./answer.js";
import { WorkTools } from "./work.js";
import { Spending } from "./spending.js";
import { formatTelegram } from "./telegram-format.js";

export type Collection = "roles" | "items" | "schedules" | "drafts";
export type View =
  | { kind: "answer"; answer: Answer }
  | { kind: "records"; collection: Collection }
  | { kind: "task"; id?: string }
  | { kind: "briefing" };
export interface Position {
  tab: string;
  page: number;
  part: number;
  filter: boolean;
  sort: boolean;
  detail?: RecordRef;
  step?: string;
}
export const initialPosition = (): Position => ({
  tab: "main",
  page: 0,
  part: 0,
  filter: false,
  sort: false,
});
export type Action = { label: string; position: Position };
interface Content {
  text: string;
  actions?: Action[][];
}
const pageSize = 6;
const stamp = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleString("en-SG", {
        timeZone: "Asia/Singapore",
      }) + " SGT"
    : "—";
const label = (value: unknown) =>
  String(value ?? "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 70);
const json = (value: unknown) => JSON.stringify(value, null, 2);
const go = (p: Position, title: string, next: Partial<Position>): Action => ({
  label: title,
  position: { ...p, part: 0, ...next },
});
const tabs = (p: Position, values: [string, string][]) =>
  values.map(([title, tab]) =>
    go(p, title, { tab, page: 0, detail: undefined, step: undefined }),
  );
const sources = (list: { label: string; url: string }[]) =>
  list.map((s) => `${s.label}\n${s.url}`).join("\n\n");

async function detail(
  db: Database,
  user: string,
  ref: RecordRef,
): Promise<string> {
  const tables = {
    role: "jobs",
    item: "daily_items",
    schedule: "daily_schedules",
    calendar_draft: "approvals",
  } as const;
  const row = (
    await db.query(
      `SELECT * FROM ${tables[ref.kind]} WHERE user_id=$1 AND id=$2 ${ref.kind === "calendar_draft" ? "AND operation='calendar_create'" : ""}`,
      [user, ref.id],
    )
  ).rows[0];
  if (!row) return "Record unavailable. It may have been removed.";
  if (ref.kind === "role")
    return `${row.title}\n${row.company} · ${row.status}\n${row.url ?? ""}\n\n${row.description || "No saved description."}\n\nNotes\n${row.notes || "No notes."}`;
  if (ref.kind === "item")
    return `${row.title}\n${row.kind} · ${row.status}\nDue: ${stamp(row.due_at)}\n\n${row.content || "No additional content."}`;
  if (ref.kind === "schedule")
    return `${row.kind} · ${row.status}\n${row.content}\n\nSchedule: ${row.schedule}\nNext run: ${stamp(row.next_run)}\nLast delivered: ${stamp(row.last_delivered)}\n${row.last_error ?? ""}`;
  return `Calendar draft · ${row.status}\nExpires: ${stamp(row.expires_at)}\n\n${json(row.payload.draft)}\n\nThis is a read-only view. Only the original approval card can authorize creation.`;
}
async function records(
  db: Database,
  user: string,
  view: View,
  p: Position,
): Promise<Content> {
  if (p.detail)
    return {
      text: await detail(db, user, p.detail),
      actions: [[go(p, "Back to list", { detail: undefined })]],
    };
  let rows: any[];
  let more: boolean;
  let title: string;
  if (view.kind === "answer") {
    const refs = view.answer.records ?? [];
    // Check ownership and existence before presenting each reference; model labels never supply identities.
    rows = [];
    for (const ref of refs.slice(p.page * pageSize, (p.page + 1) * pageSize)) {
      if (ref.kind === "role") {
        const row = (
          await db.query(
            "SELECT company,title FROM jobs WHERE user_id=$1 AND id=$2",
            [user, ref.id],
          )
        ).rows[0];
        rows.push({
          ref,
          title: row ? `${row.company} — ${row.title}` : "Record unavailable.",
        });
      } else {
        const text = await detail(db, user, ref);
        rows.push({ ref, title: text.split("\n")[0] });
      }
    }
    more = refs.length > (p.page + 1) * pageSize;
    title = "Referenced records";
  } else {
    const collection = view.kind === "records" ? view.collection : "items";
    const config = {
      roles: {
        table: "jobs",
        kind: "role",
        title: "company || ' — ' || title",
        filter: "status<>'archived'",
        order: "company,title,id",
      },
      items: {
        table: "daily_items",
        kind: "item",
        title: "title",
        filter: "status='open'",
        order: "due_at NULLS LAST,title,id",
      },
      schedules: {
        table: "daily_schedules",
        kind: "schedule",
        title: "content",
        filter: "status IN ('scheduled','processing')",
        order: "next_run,id",
      },
      drafts: {
        table: "approvals",
        kind: "calendar_draft",
        title: "payload->'draft'->>'title'",
        filter: "status='pending' AND expires_at>now()",
        order: "expires_at,id",
      },
    }[collection];
    rows = (
      await db.query(
        `SELECT id,${config.title} AS title,status FROM ${config.table} WHERE user_id=$1 ${collection === "drafts" ? "AND operation='calendar_create'" : ""} ${p.filter ? "AND " + config.filter : ""} ORDER BY ${p.sort ? "created_at DESC,id" : config.order} LIMIT $2 OFFSET $3`,
        [user, pageSize + 1, p.page * pageSize],
      )
    ).rows;
    more = rows.length > pageSize;
    rows = rows
      .slice(0, pageSize)
      .map((row) => ({ ...row, ref: { kind: config.kind, id: row.id } }));
    title =
      collection[0]!.toUpperCase() +
      collection.slice(1) +
      (p.filter ? " · active" : " · all");
  }
  const navigation: Action[] = [];
  if (p.page) navigation.push(go(p, "Previous", { page: p.page - 1 }));
  if (more) navigation.push(go(p, "Next", { page: p.page + 1 }));
  return {
    text: `${title} · page ${p.page + 1}\n\n${rows.length ? rows.map((r, i) => `${i + 1}. ${r.title}${r.status ? " · " + r.status : ""}`).join("\n\n") : "No records on this page. Refresh or go back."}`,
    actions: [
      ...rows.map((r, i) => [
        go(p, `${i + 1}. ${label(r.title)}`, { detail: r.ref }),
      ]),
      navigation,
      ...(view.kind === "answer"
        ? []
        : [
            [
              go(p, p.filter ? "Show all" : "Active only", {
                filter: !p.filter,
                page: 0,
              }),
              go(p, p.sort ? "Default order" : "Newest first", {
                sort: !p.sort,
                page: 0,
              }),
            ],
          ]),
    ],
  };
}
async function task(
  db: Database,
  user: string,
  view: Extract<View, { kind: "task" }>,
  p: Position,
): Promise<Content> {
  const id =
    view.id ??
    (
      await db.query(
        "SELECT id FROM work_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [user],
      )
    ).rows[0]?.id;
  const snapshot = id ? await new WorkTools(db).snapshot(user, id) : null;
  if (!snapshot) return { text: "No tracked task yet." };
  const { task: t, steps, evidence, receipts, counts } = snapshot;
  const header = `${t.objective}\n${t.status}${t.pause_reason ? " · " + t.pause_reason : ""}\n${counts.done}/${counts.total} steps recorded complete · ${counts.blocked} blocked\n\n`;
  const actions: Action[][] = [
    tabs(p, [
      ["Steps", "main"],
      ["Evidence", "evidence"],
      ["Costs", "costs"],
    ]),
  ];
  if (p.step) {
    const step = steps.find((s) => s.key === p.step);
    if (!step)
      return {
        text: header + "This step has changed or was removed.",
        actions,
      };
    const proofs = Array.isArray(step.proofs) ? step.proofs : [];
    const supported = [...evidence, ...receipts].filter((e) =>
      proofs.includes(e.id),
    );
    actions.push([go(p, "Back to steps", { step: undefined, tab: "main" })]);
    return {
      text: `${header}${step.title} · ${step.status}\n\n${step.result || "No recorded result."}\n\nRecorded proofs\n${supported.length ? supported.map((e) => json(e)).join("\n\n") : "No matching proofs in the latest bounded snapshot."}\n\nRecorded support does not certify semantic correctness or full coverage.`,
      actions,
    };
  }
  if (p.tab === "costs") {
    const run = (
      await db.query(
        "SELECT id FROM runtime_runs WHERE user_id=$1 AND task_id=$2 ORDER BY started_at DESC LIMIT 1",
        [user, id],
      )
    ).rows[0];
    const cost = run ? await new Spending(db, user, run.id).summary() : null;
    return {
      text: `${header}Active execution: ${Math.round(t.used_ms / 1000)} / ${Math.round(t.budget_ms / 1000)} seconds\nModel calls: ${t.used_models} / ${t.budget_models}\nTool calls: ${t.used_tools} / ${t.budget_tools}\n\nReported model/research charges: ${cost ? "$" + Number(cost.reported_usd).toFixed(4) : "unknown"}\nRequests with unknown charge: ${cost?.unknown_requests ?? "unknown"}\nEstimated cost for those requests: ${cost ? "$" + Number(cost.estimated_unknown_usd).toFixed(4) : "unknown"}\nSpeech charges are separate. No dollar cap.`,
      actions,
    };
  }
  const list = p.tab === "evidence" ? evidence : steps;
  const current = list.slice(p.page * pageSize, (p.page + 1) * pageSize);
  const text =
    p.tab === "evidence"
      ? current
          .map(
            (e) =>
              `${e.claim}\n${e.applicability}: ${e.reason}\n“${e.quote}”\n${e.url}`,
          )
          .join("\n\n")
      : current.map((s) => `${s.title} · ${s.status}`).join("\n\n");
  if (p.tab !== "evidence")
    actions.push(
      ...current.map((s) => [go(p, label(s.title), { step: s.key })]),
    );
  actions.push([
    ...(p.page ? [go(p, "Previous", { page: p.page - 1 })] : []),
    ...(list.length > (p.page + 1) * pageSize
      ? [go(p, "Next", { page: p.page + 1 })]
      : []),
  ]);
  return {
    text:
      header +
      (text || "Nothing recorded here.") +
      (p.tab === "evidence"
        ? "\n\nLatest 100 evidence records at most. Applicability remains an agent judgment."
        : "\n\nCounts describe recorded support, not independently verified completion."),
    actions,
  };
}
async function content(
  db: Database,
  user: string,
  view: View,
  p: Position,
): Promise<Content> {
  if (view.kind === "records") return records(db, user, view, p);
  if (view.kind === "task") return task(db, user, view, p);
  if (view.kind === "briefing") {
    if (p.tab !== "main")
      return records(
        db,
        user,
        { kind: "records", collection: p.tab as Collection },
        p,
      );
    const items = (
      await db.query(
        "SELECT kind,count(*) AS count FROM daily_items WHERE user_id=$1 AND status='open' GROUP BY kind",
        [user],
      )
    ).rows;
    return {
      text: `Daily overview\n\n${items.map((r) => `${r.kind === "task" ? "Open tasks" : "Notes"}: ${r.count}`).join("\n") || "No open tasks or notes."}\n\nExpand a group to browse saved data. Task due dates do not create reminders.`,
      actions: [
        tabs(p, [
          ["Tasks & notes", "items"],
          ["Schedules", "schedules"],
          ["Calendar drafts", "drafts"],
        ]),
      ],
    };
  }
  const a = view.answer;
  const actions = [
    tabs(p, [
      ["Summary", "main"],
      ...(a.sections?.length
        ? [["Sections", "sections"] as [string, string]]
        : []),
      ...(a.sources?.length
        ? [["Sources", "sources"] as [string, string]]
        : []),
      ...(a.records?.length
        ? [["Records", "records"] as [string, string]]
        : []),
    ]),
  ];
  if (p.tab === "records") {
    const found = await records(db, user, view, p);
    return { ...found, actions: [...actions, ...(found.actions ?? [])] };
  }
  if (p.tab === "sources")
    return {
      text: sources(a.sources ?? []) || "No sources attached.",
      actions,
    };
  if (p.tab === "sections") {
    const section = a.sections?.[p.page];
    actions.push([
      ...(p.page ? [go(p, "Previous section", { page: p.page - 1 })] : []),
      ...((a.sections?.length ?? 0) > p.page + 1
        ? [go(p, "Next section", { page: p.page + 1 })]
        : []),
    ]);
    return {
      text: section
        ? `${section.title}\n\n${section.body}`
        : "No section here.",
      actions,
    };
  }
  return {
    text:
      a.reply +
      (a.numbers?.length
        ? "\n\n" + a.numbers.map((n) => `${n.label}: ${n.value}`).join("\n")
        : ""),
    actions,
  };
}
export async function renderView(
  db: Database,
  user: string,
  view: View,
  p: Position,
) {
  const result = await content(db, user, view, p);
  const parts = formatTelegram(
    result.text,
    view.kind === "answer" ? 1800 : 3000,
  );
  const part = Math.min(p.part, Math.max(0, parts.length - 1));
  const formatted = parts[part] ?? { text: "No content.", entities: [] };
  const actions = result.actions ?? [];
  if (parts.length > 1)
    actions.push([
      ...(part ? [go(p, "Previous text", { part: part - 1 })] : []),
      ...(part + 1 < parts.length
        ? [go(p, part ? "Next text" : "Show more", { part: part + 1 })]
        : []),
    ]);
  if (view.kind === "briefing" && p.tab !== "main")
    actions.push([go(p, "Collapse to overview", { ...initialPosition() })]);
  actions.push([go(p, "Refresh", {})]);
  return {
    text:
      formatted.text +
      `\n\n${parts.length > 1 ? `Text ${part + 1}/${parts.length} · ` : ""}${view.kind === "answer" ? "Answer snapshot · viewed" : "Updated"} ${stamp(new Date().toISOString())}`,
    entities: formatted.entities,
    actions: actions.filter((row) => row.length),
  };
}
