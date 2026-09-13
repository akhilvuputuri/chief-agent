import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { alignmentTarget } from "./alignment-schema.js";
import { ToolValidationError } from "./tool-errors.js";

function fail(message: string): never {
  throw new ToolValidationError("Preparation provenance: " + message);
}
const linkSchema = z
  .object({
    scopeId: z.string().uuid(),
    jobId: z.string().uuid(),
    preparationId: z.string().min(1).max(60),
  })
  .strict();
export type PreparationLink = z.infer<typeof linkSchema>;

const snapshotSchema = z.object({
  version: z.literal(1),
  scopeId: z.string().uuid(),
  targets: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      company: z.string(),
      url: z.string().nullable(),
      description: z.string(),
      updated_at: z.string().min(1),
    }),
  ),
  memories: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
        updated_at: z.string().min(1),
      }),
    )
    .max(30),
  skill: z.object({
    version: z.string().min(1),
    content: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  createdAt: z.string().min(1),
});
// Older stored reports remain readable, but an unknown may only become a saved
// preparation chain once its report contains an explicit clarification question.
const requirementSchema = alignmentTarget.shape.requirements.element.extend({
  fit: alignmentTarget.shape.requirements.element.shape.fit.extend({
    question: z.string().max(1200).optional(),
  }),
});
const targetSchema = alignmentTarget.extend({
  requirements: z.array(requirementSchema).max(16),
});
type Target = z.infer<typeof targetSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;
type Citation = Target["identity"]["evidence"][number];
export type PreparationCitation =
  | { kind: "job_snapshot"; refId: string; quote: string }
  | {
      kind: "web";
      refId: string;
      quote: string;
      url: string;
      retrievedAt: string;
    };
export type PreparationRequirement = Omit<
  Target["requirements"][number],
  "evidence" | "fit"
> & {
  evidence: PreparationCitation[];
  fit: Omit<Target["requirements"][number]["fit"], "memoryEvidence"> & {
    memoryEvidence: Array<{ key: string; quote: string; updatedAt: string }>;
  };
};
export type PreparationInterview = Omit<
  Target["interviews"]["findings"][number],
  "evidence"
> & { evidence: PreparationCitation[] };
export type PreparationChain = PreparationLink & {
  childRunId: string;
  capturedAt: string;
  skill: { version: string; sha256: string };
  job: {
    id: string;
    title: string;
    company: string;
    url: string | null;
    updatedAt: string;
    descriptionHash: string;
  };
  reportStatus: Target["status"];
  identity: Omit<Target["identity"], "evidence"> & {
    evidence: PreparationCitation[];
  };
  requirements: PreparationRequirement[];
  interviews: PreparationInterview[];
  action: string;
  why: string;
  doneWhen: string;
  priority: "minimum" | "optional";
  effortEstimate: string | null;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unique = (ids: string[], label: string) => {
  if (new Set(ids).size !== ids.length) fail("duplicate " + label);
};

/** Resolve provenance from successful persisted specialist reports, never from
 * coordinator-supplied requirement, background or source text. No writes occur. */
export async function resolvePreparationChain(
  db: Database,
  user: string,
  rawLinks: readonly PreparationLink[],
): Promise<PreparationChain[]> {
  const links = z.array(linkSchema).min(1).max(16).parse(rawLinks);
  unique(
    links.map((l) => JSON.stringify([l.scopeId, l.jobId, l.preparationId])),
    "preparation references",
  );
  const scopes = new Map<string, Snapshot>();
  const output: PreparationChain[] = [];
  for (const link of links) {
    let scope = scopes.get(link.scopeId);
    if (!scope) {
      const rows = (
        await db.query(
          `SELECT data FROM events WHERE user_id=$1 AND type='job_alignment.scope'
           AND data->>'scopeId'=$2 ORDER BY id LIMIT 2`,
          [user, link.scopeId],
        )
      ).rows;
      if (rows.length !== 1)
        fail("alignment scope must uniquely belong to this owner");
      scope = snapshotSchema.parse(rows[0].data);
      unique(
        scope.targets.map((j) => j.id),
        "frozen job IDs",
      );
      unique(
        scope.memories.map((m) => m.key),
        "frozen memory keys",
      );
      if (hash(scope.skill.content) !== scope.skill.sha256)
        fail("frozen skill hash does not match its content");
      scopes.set(link.scopeId, scope);
    }
    const job = scope.targets.find((j) => j.id === link.jobId);
    if (!job) fail("job is not in the frozen alignment scope");
    const owned = await db.query(
      "SELECT 1 FROM jobs WHERE id=$1 AND user_id=$2",
      [link.jobId, user],
    );
    if (!owned.rows.length) fail("job unavailable for this owner");
    const rows = (
      await db.query(
        `SELECT c.result,c.run_id FROM runtime_calls c
         JOIN runtime_runs r ON r.id=c.run_id
         WHERE r.user_id=$1 AND c.operation='job_alignment_report' AND c.state='success'
         AND c.result->'targets' @> $3::jsonb
         AND EXISTS(SELECT 1 FROM events e WHERE e.run_id=r.id AND e.user_id=r.user_id
           AND e.type='research.child_started' AND e.data->'profile'->>'scopeId'=$2)
         ORDER BY c.finished_at,c.id LIMIT 2`,
        [user, link.scopeId, JSON.stringify([{ targetId: link.jobId }])],
      )
    ).rows;
    if (rows.length !== 1)
      fail("role needs one uniquely matching successful specialist report");
    const targets = z
      .array(targetSchema)
      .min(1)
      .max(2)
      .parse(rows[0].result.targets);
    unique(
      targets.map((t) => t.targetId),
      "report target IDs",
    );
    const target = targets.find((t) => t.targetId === link.jobId)!;
    const childRunId: string = rows[0].run_id;
    if (!["matched", "saved_only"].includes(target.identity.match))
      fail("mismatched or unverified role identity cannot justify preparation");
    unique(
      target.requirements.map((r) => r.id),
      "requirement IDs",
    );
    unique(
      target.interviews.findings.map((f) => f.id),
      "interview IDs",
    );
    unique(
      target.preparation.map((p) => p.id),
      "preparation IDs",
    );
    const prep = target.preparation.find((p) => p.id === link.preparationId);
    if (!prep) fail("preparation ID is not in this role's report");
    unique(prep.requirementIds, "linked requirement IDs");
    unique(prep.interviewIds, "linked interview IDs");
    if (!prep.requirementIds.length)
      fail("preparation must link at least one role requirement");
    const requirements = prep.requirementIds.map((id) => {
      const value = target.requirements.find((r) => r.id === id);
      if (!value) fail("linked requirement is not in this role's report");
      return value;
    });
    const interviews = prep.interviewIds.map((id) => {
      const value = target.interviews.findings.find((f) => f.id === id);
      if (!value) fail("linked interview is not in this role's report");
      return value;
    });
    const sources = new Map<
      string,
      { content: string; url: string; retrievedAt: string }
    >();
    const cite = async (
      evidence: Citation[],
      webOnly = false,
    ): Promise<PreparationCitation[]> => {
      if (!evidence.length) fail("claims require a source quotation");
      const resolved: PreparationCitation[] = [];
      for (const c of evidence) {
        if (c.kind === "job_snapshot") {
          if (
            webOnly ||
            c.refId !== job.id ||
            !job.description.includes(c.quote)
          )
            fail("snapshot quote must match this frozen role description");
          resolved.push({ ...c, kind: "job_snapshot" });
        } else {
          let source = sources.get(c.refId);
          if (!source) {
            // Mirrors checkResearchQuote's owner and successful child-read fence,
            // including source_read and wrapped/flat persisted tool results.
            const row = (
              await db.query(
                `SELECT s.content,s.url,s.retrieved_at::text AS retrieved_at
                 FROM research_sources s WHERE s.id=$1 AND s.user_id=$2
                 AND EXISTS(SELECT 1 FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id
                   WHERE c.run_id=$3 AND r.user_id=$2 AND c.state='success'
                   AND c.operation IN ('web_read','source_read')
                   AND COALESCE(c.result->'result'->>'sourceId',c.result->>'sourceId')=$1::text)`,
                [c.refId, user, childRunId],
              )
            ).rows[0];
            if (!row)
              fail(
                "web source must belong to this owner and be read by this child",
              );
            source = {
              content: row.content,
              url: row.url,
              retrievedAt: row.retrieved_at,
            };
            sources.set(c.refId, source);
          }
          if (!source.content.includes(c.quote))
            fail("web quotation does not match the recorded source");
          resolved.push({
            ...c,
            kind: "web",
            url: source.url,
            retrievedAt: source.retrievedAt,
          });
        }
      }
      return resolved;
    };
    const identity = {
      ...target.identity,
      evidence:
        target.identity.evidence.length || target.identity.match === "matched"
          ? await cite(
              target.identity.evidence,
              target.identity.match === "matched",
            )
          : [],
    };
    const resolvedRequirements: PreparationRequirement[] = [];
    for (const requirement of requirements) {
      if (requirement.fit.status === "unknown") {
        if (!requirement.fit.question?.trim())
          fail(
            "unknown experience requires an explicit report clarification question",
          );
      } else if (!requirement.fit.memoryEvidence.length) {
        fail("non-unknown fit requires frozen background evidence");
      }
      const memoryEvidence = requirement.fit.memoryEvidence.map((m) => {
        const saved = scope.memories.find((s) => s.key === m.key);
        if (!saved || !saved.value.includes(m.quote))
          fail("background quote must match the selected frozen memory");
        return { ...m, updatedAt: saved.updated_at };
      });
      resolvedRequirements.push({
        ...requirement,
        evidence: await cite(requirement.evidence),
        fit: { ...requirement.fit, memoryEvidence },
      });
    }
    const resolvedInterviews: PreparationInterview[] = [];
    for (const interview of interviews) {
      if (
        interview.scope === "exact_role" &&
        [
          interview.roleMatch,
          interview.locationMatch,
          interview.levelMatch,
        ].some((m) => m !== "matched")
      )
        fail(
          "exact-role interview evidence must match role, location and level",
        );
      if (
        interview.scope === "employer_general" &&
        interview.sourceType !== "official"
      )
        fail("employer-general interview evidence must be official");
      if (
        interview.confidence === "high" &&
        (interview.sourceType !== "official" ||
          !interview.date ||
          !["exact_role", "employer_general"].includes(interview.scope))
      )
        fail(
          "high-confidence interview evidence requires dated applicable official sources",
        );
      resolvedInterviews.push({
        ...interview,
        evidence: await cite(interview.evidence, true),
      });
    }
    output.push({
      ...link,
      childRunId,
      capturedAt: scope.createdAt,
      skill: { version: scope.skill.version, sha256: scope.skill.sha256 },
      job: {
        id: job.id,
        title: job.title,
        company: job.company,
        url: job.url,
        updatedAt: job.updated_at,
        descriptionHash: hash(job.description),
      },
      reportStatus: target.status,
      identity,
      requirements: resolvedRequirements,
      interviews: resolvedInterviews,
      action: prep.action,
      why: prep.why,
      doneWhen: prep.doneWhen,
      priority: prep.priority,
      effortEstimate: prep.effortEstimate,
    });
  }
  return output;
}
