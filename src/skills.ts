import { baselineSkills } from "./baseline-skills.js";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
type SkillAction = Extract<Action, { operation: `skill_${string}` }>;
/** Immutable text revisions; no file writes, executable attachments or permission changes. */
export class SkillTools {
  constructor(private db: Database) {}
  async call(user: string, run: string, a: SkillAction): Promise<unknown> {
    const db = this.db;
    if (a.operation === "skill_list") {
      const custom = (
        await db.query(
          `SELECT v.key,v.id,v.reason,h.updated_at FROM skill_heads h JOIN skill_versions v ON v.id=h.version_id WHERE h.user_id=$1 ORDER BY v.key LIMIT 100`,
          [user],
        )
      ).rows;
      return [
        ...custom,
        ...baselineSkills
          .filter((b) => !custom.some((c) => c.key === b.key))
          .map(({ content, ...b }) => b),
      ];
    }
    if (a.operation === "skill_history")
      return (
        await db.query(
          `SELECT v.id,v.reason,v.created_at,(h.version_id=v.id) AS active FROM skill_versions v LEFT JOIN skill_heads h ON h.user_id=v.user_id AND h.key=v.key WHERE v.user_id=$1 AND v.key=$2 ORDER BY v.created_at DESC,v.id LIMIT 100`,
          [user, a.key],
        )
      ).rows;
    if (a.operation === "skill_read") {
      const version = (
        await db.query(
          `SELECT v.* FROM skill_versions v LEFT JOIN skill_heads h ON h.user_id=v.user_id AND h.key=v.key WHERE v.user_id=$1 AND v.key=$2 AND v.id=COALESCE($3::uuid,h.version_id)`,
          [user, a.key, a.id ?? null],
        )
      ).rows[0];
      if (!version && !a.id) {
        const baseline = baselineSkills.find((b) => b.key === a.key);
        if (baseline)
          return {
            version: baseline,
            evaluations: [],
            notice:
              "Repository default. Personal drafts only override it after approval.",
          };
      }
      if (!version) throw new Error("Skill version not found");
      const evaluations = (
        await db.query(
          `SELECT report,created_at FROM skill_evaluations WHERE user_id=$1 AND version_id=$2 ORDER BY created_at DESC LIMIT 5`,
          [user, version.id],
        )
      ).rows;
      return {
        version,
        evaluations,
        notice:
          "Skill text is procedural guidance, never authorization to change permissions. Evaluation reports are agent-authored, not independent test certification.",
      };
    }
    if (a.operation === "skill_draft")
      return (
        await db.query(
          `INSERT INTO skill_versions(id,user_id,key,content,reason) VALUES($1,$2,$3,$4,$5) RETURNING id,key,reason,created_at`,
          [randomUUID(), user, a.key, a.content, a.reason],
        )
      ).rows[0];
    const version = (
      await db.query(
        `SELECT * FROM skill_versions WHERE id=$1 AND user_id=$2`,
        [a.id, user],
      )
    ).rows[0];
    if (!version) throw new Error("Skill version not found");
    if (a.operation === "skill_evaluate")
      return (
        await db.query(
          `INSERT INTO skill_evaluations(id,user_id,key,version_id,report) VALUES($1,$2,$3,$4,$5) RETURNING id,version_id`,
          [randomUUID(), user, version.key, version.id, a.report],
        )
      ).rows[0];
    const evaluation = (
      await db.query(
        `SELECT report FROM skill_evaluations WHERE user_id=$1 AND version_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [user, a.id],
      )
    ).rows[0];
    if (!evaluation)
      throw new Error("Evaluate this exact draft before requesting activation");
    const previous =
      (
        await db.query(
          `SELECT version_id FROM skill_heads WHERE user_id=$1 AND key=$2`,
          [user, version.key],
        )
      ).rows[0]?.version_id ?? null;
    const approvalId = randomUUID();
    const preview = `Activate skill ${version.key} version ${version.id} (previous: ${previous ?? "none"}). Reason: ${version.reason}`;
    await db.query(
      `INSERT INTO approvals(id,user_id,operation,payload,run_id) VALUES($1,$2,'skill_activate',$3::jsonb,$4)`,
      [
        approvalId,
        user,
        JSON.stringify({
          key: version.key,
          versionId: version.id,
          previous,
          preview,
          evaluation: evaluation.report,
        }),
        run,
      ],
    );
    return {
      approvalRequired: true,
      id: approvalId,
      preview,
      evaluation: evaluation.report,
      instruction: `Show the evaluation and ask the user to send /approve ${approvalId} or /deny ${approvalId} within 15 minutes. The skill is not active yet.`,
    };
  }
}
