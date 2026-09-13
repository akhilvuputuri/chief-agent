import type { Database } from "./db.js";
import { boundedBytes } from "./providers.js";
import { SerialQueue } from "./security.js";
import { z } from "zod";
function chainText(task: any, render: (chain: any) => string): string {
  const text = (task.evidence_chain ?? []).map(render).join("\n\n");
  return text.length <= 30000
    ? text
    : text.slice(0, 29500) +
        "\n[Shortened for Sheets; use prep_task_read for the full saved chain.]";
}
export const sheetTabs = [
  "Target roles",
  "Preparation gaps",
  "Preparation tasks",
];
export function sheetRequests(tables: unknown[][][]) {
  return tables.flatMap((table, sheetId) => [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: {
            rowCount: Math.max(1000, table.length + 50),
            columnCount: 20,
            frozenRowCount: 1,
          },
        },
        fields: "gridProperties",
      },
    },
    // Explicit string values: listing text can never execute as a spreadsheet formula.
    // The range also clears stale managed rows in the same atomic batch.
    {
      updateCells: {
        range: { sheetId },
        rows: table.map((row) => ({
          values: row.map((v) => ({
            userEnteredValue: { stringValue: String(v ?? "") },
          })),
        })),
        fields: "userEnteredValue",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.12, green: 0.2, blue: 0.3 },
            textFormat: {
              bold: true,
              foregroundColor: { red: 1, green: 1, blue: 1 },
            },
          },
        },
        fields: "userEnteredFormat",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 20 },
        properties: { pixelSize: 220 },
        fields: "pixelSize",
      },
    },
    {
      repeatCell: {
        range: { sheetId },
        cell: {
          userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" },
        },
        fields:
          "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
      },
    },
    {
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            endRowIndex: table.length,
            startColumnIndex: 0,
            endColumnIndex: table[0]?.length ?? 1,
          },
        },
      },
    },
  ]);
}
export class SheetsTools {
  private queue = new SerialQueue();
  constructor(
    private db: Database,
    private config: {
      owner: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      spreadsheetId: string;
    },
    private request: typeof fetch = fetch,
  ) {}
  async sync(user: string) {
    if (!this.config.owner || user !== this.config.owner)
      throw new Error("Sheets is not connected for this user");
    return this.queue.run(user, () => this.write(user));
  }
  private async write(user: string) {
    const c = this.config;
    if (
      !c.refreshToken ||
      !c.clientId ||
      !c.clientSecret ||
      !/^[a-zA-Z0-9_-]+$/.test(c.spreadsheetId)
    )
      throw new Error("Google Sheets setup is incomplete");
    // One statement gives all three tabs a consistent database snapshot.
    const {
      rows: [snapshot],
    } = await this.db.query(
      `SELECT
      (SELECT COALESCE(jsonb_agg(j ORDER BY j.company,j.title),'[]') FROM jobs j WHERE user_id=$1) AS jobs,
      (SELECT COALESCE(jsonb_agg(r ORDER BY r.company,r.topic),'[]') FROM
        (SELECT p.*,j.company,j.title,COALESCE(s.url,j.url) source_url,s.retrieved_at FROM preparation_requirements p
         JOIN jobs j ON j.id=p.job_id LEFT JOIN research_sources s ON s.id=p.source_id WHERE j.user_id=$1) r) AS requirements,
      (SELECT COALESCE(jsonb_agg(t ORDER BY t.topic),'[]') FROM preparation_tasks t WHERE user_id=$1) AS tasks`,
      [user],
    );
    const tables = [
      [
        ["Role ID", "Company", "Role", "Status", "Listing", "Notes", "Updated"],
        ...snapshot.jobs.map((j: any) => [
          j.id,
          j.company,
          j.title,
          j.status,
          j.url,
          j.notes,
          j.updated_at,
        ]),
      ],
      [
        [
          "Requirement ID",
          "Role ID",
          "Company",
          "Role",
          "Topic",
          "Importance",
          "Assessment",
          "Listing evidence",
          "Source",
          "Retrieved",
          "Background evidence",
          "Question",
          "Updated",
        ],
        ...snapshot.requirements.map((r: any) => [
          r.id,
          r.job_id,
          r.company,
          r.title,
          r.topic,
          r.importance,
          r.assessment,
          r.source_quote,
          r.source_url,
          r.retrieved_at,
          r.evidence,
          r.question,
          r.updated_at,
        ]),
      ],
      [
        [
          "Task ID",
          "Topic (shared across roles)",
          "Priority",
          "Status",
          "Exercise",
          "Completion criteria",
          "Updated",
          "Provenance",
          "Linked roles",
          "Quoted requirements",
          "Experience or unresolved question",
          "Why this preparation",
          "Source references",
          "Original readiness checks",
        ],
        ...snapshot.tasks.map((t: any) => [
          t.id,
          t.topic,
          t.priority,
          t.status,
          t.exercise,
          t.completion_criteria,
          t.updated_at,
          t.evidence_chain?.length
            ? "Linked; status is reported progress"
            : "Legacy task; provenance unavailable",
          chainText(t, (c) => `${c.job.company} — ${c.job.title} (${c.jobId})`),
          chainText(t, (c) =>
            c.requirements
              .map(
                (r: any) =>
                  `${r.requirement}\n${r.evidence.map((e: any) => e.quote).join("\n")}`,
              )
              .join("\n\n"),
          ),
          chainText(t, (c) =>
            c.requirements
              .map(
                (r: any) =>
                  `${r.requirement}: ${r.fit.status}\n${r.fit.explanation}\n${r.fit.question ?? ""}\n${r.fit.memoryEvidence.map((m: any) => `${m.key}: ${m.quote}`).join("\n")}`,
              )
              .join("\n\n"),
          ),
          chainText(t, (c) => c.why),
          chainText(
            t,
            (c) =>
              `${c.scopeId} / ${c.preparationId}\n${c.job.url ?? ""}\n${c.requirements.flatMap((r: any) => r.evidence.map((e: any) => e.url ?? `Saved description ${e.refId}`)).join("\n")}`,
          ),
          chainText(
            t,
            (c) =>
              `${c.action}\nReady when: ${c.doneWhen}\n${c.effortEstimate ?? ""}`,
          ),
        ]),
      ],
    ];
    if (tables.some((t) => t.length > 5000))
      throw new Error("Sheet snapshot exceeds the supported 5000 rows per tab");
    const read = async (r: Response) =>
      JSON.parse(new TextDecoder().decode(await boundedBytes(r, 1000000)));
    const token = z.object({ access_token: z.string().min(1) }).parse(
      await read(
        await this.request("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.clientSecret,
            refresh_token: c.refreshToken,
            grant_type: "refresh_token",
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }),
      ),
    );
    await read(
      await this.request(
        `https://sheets.googleapis.com/v4/spreadsheets/${c.spreadsheetId}:batchUpdate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ requests: sheetRequests(tables) }),
          redirect: "error",
          signal: AbortSignal.timeout(25000),
        },
      ),
    );
    return {
      synced: true,
      url: `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/edit`,
      counts: tables.map((t) => t.length - 1),
      note: "Managed tabs mirror the database. Ask in Telegram to change tracked data; edits to these tabs are replaced on sync.",
    };
  }
}
