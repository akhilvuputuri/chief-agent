import {
  contentHash,
  type PluginAgent,
  type PluginRegistry,
} from "./plugins.js";
import { plugins } from "./plugin-registry.js";
import { scrubTrace } from "./trace-scrub.js";
import type { Execution } from "./execution.js";

/** Pins are written only by the host, never accepted from tool arguments. */
export async function pinPlugin(
  execution: Execution,
  agentId: string,
  registry: PluginRegistry = plugins,
): Promise<PluginAgent> {
  const active = registry.get(agentId); // Disabling a package revokes future delegation, including old tasks.
  const { db, user, run } = execution;
  const prior = (
    await db.query(
      `SELECT e.data FROM events e JOIN work_turns w ON w.run_id=e.run_id AND w.user_id=e.user_id
     WHERE e.user_id=$1 AND e.type='plugin.pinned' AND e.data->>'agentId'=$2
       AND (e.run_id=$3 OR (w.task_id IS NOT NULL AND w.task_id=(SELECT task_id FROM work_turns WHERE run_id=$3 AND user_id=$1)))
     ORDER BY e.created_at,e.id LIMIT 1`,
      [user, agentId, run],
    )
  ).rows[0]?.data;
  let selected = active;
  if (prior) {
    selected = prior.definition;
    if (
      !selected ||
      selected.agentId !== agentId ||
      contentHash(selected) !== prior.definitionHash
    )
      throw new Error(
        "Plugin validation: saved definition integrity check failed; inspect this task before continuing",
      );
    if (
      selected.contract !== active.contract ||
      selected.tools.some((t) => !active.tools.includes(t))
    )
      throw new Error(
        "Plugin validation: pinned definition no longer meets host permissions; inspect this task before continuing",
      );
  } else {
    // Approved owner overrides remain authoritative. Freeze their exact contents for this task.
    for (const skill of selected.skillDefinitions) {
      const version = (
        await db.query(
          `SELECT v.id,v.content FROM skill_heads h JOIN skill_versions v ON v.id=h.version_id AND v.user_id=h.user_id AND v.key=h.key WHERE h.user_id=$1 AND h.key=$2`,
          [user, skill.key],
        )
      ).rows[0];
      if (version) {
        skill.content = version.content;
        skill.version = `private:${version.id}`;
      }
    }
    if (contentHash(scrubTrace(selected)) !== contentHash(selected))
      throw new Error(
        "Plugin validation: definition contains credential-like text; remove it before running this plugin",
      );
    await execution.trace("plugin.pinned", {
      version: 1,
      agentId,
      definitionHash: contentHash(selected),
      definition: selected,
    });
  }
  await execution.trace("plugin.selected", {
    version: 1,
    agentId,
    pluginVersion: selected.pluginVersion,
    pluginHash: selected.pluginHash,
    definitionHash: contentHash(selected),
    reused: !!prior,
    skills: selected.skillDefinitions.map((s) => ({
      key: s.key,
      version: s.version,
      sha256: contentHash(s.content),
    })),
  });
  return selected;
}
