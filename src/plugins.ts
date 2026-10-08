import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { MODEL_TIERS } from "./model-policy.js";
import { action } from "./protocol.js";
import { REASONING_EFFORTS } from "./model.js";

const id = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(48);
const file = z
  .string()
  .regex(/^[a-zA-Z0-9_/-]+\.(md|json)$/)
  .max(160);
/** An operation name; the registry checks it against real operations and the host's grant. */
const operation = z.string().regex(/^[a-z][a-z_]{1,47}$/);
/** Report contracts the host knows how to validate. A package picks one; it cannot add its own. */
export const AGENT_CONTRACTS = [
  "public-research/v1",
  "findings/v1",
  "media/v1",
] as const;
const agent = z
  .object({
    id,
    description: z.string().min(1).max(600),
    instructions: file,
    contract: z.enum(AGENT_CONTRACTS),
    tools: z.array(operation).min(1).max(24),
    skills: z.array(id).max(8),
    // These are host ceilings, not permissions a package can raise.
    limits: z
      .object({
        ms: z.number().int().min(1000).max(180000),
        models: z.number().int().min(1).max(12),
        tools: z.number().int().min(1).max(40),
      })
      .strict(),
    /** Default model tier and reasoning effort; a call may ask for others. */
    model: z.enum(MODEL_TIERS).optional(),
    effort: z.enum(REASONING_EFFORTS).optional(),
    /** False keeps an agent for host workflows only; it is not in the coordinator's catalogue. */
    invocable: z.boolean().optional(),
  })
  .strict();
export const pluginManifest = z
  .object({
    format: z.literal("companion.plugin/v1"),
    id,
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(32),
    description: z.string().min(1).max(1000),
    agents: z.array(agent).max(16),
    skills: z.array(z.object({ id, path: file }).strict()).max(16),
  })
  .strict();
const bundleSchema = z
  .object({
    format: z.literal("companion.plugin-bundle/v1"),
    manifest: pluginManifest,
    files: z.record(z.string().max(32000)),
  })
  .strict();
export type PluginBundle = z.infer<typeof bundleSchema>;
export type PluginSkill = {
  key: string;
  version: string;
  reason: string;
  description: string;
  content: string;
};
export type PluginAgent = z.infer<typeof agent> & {
  agentId: string;
  pluginId: string;
  pluginVersion: string;
  pluginHash: string;
  /** Host-pinned model ID from the registry; wins over any tier. */
  hostModel?: string;
  skillDefinitions: PluginSkill[];
};
const registrySchema = z
  .object({
    format: z.literal("companion.plugin-registry/v1"),
    researchAgent: z.string().max(100).nullable(),
    /** Short agent types, such as "email" for "core/email". */
    aliases: z.record(id, z.string().max(100)).optional(),
    /** Operations the coordinator does not get: an agent in the catalogue does that work. */
    delegated: z.array(operation).max(80).optional(),
    enabled: z
      .array(
        z
          .object({
            path: id,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            agents: z.array(id).max(16),
            allowTools: z.array(operation).max(80),
            // Host configuration only; never taken from package instructions/model arguments.
            model: z
              .string()
              .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/)
              .max(150)
              .optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
function unique(values: string[], what: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`Plugin compatibility: duplicate ${what}`);
}
/** Coordinator and report operations; an agent can never be granted these. */
export const NEVER_GRANTED = new Set([
  "mcp_tools",
  "mcp_read",
  "mcp_write",
  "mcp_operation",
  "agent_run",
  "agent_report",
  "research_report",
  "media_report",
  "finish_turn",
  "tools_load",
  "job_alignment_start",
  "job_alignment_resume",
  "job_alignment_read",
  "job_alignment_report",
  "job_alignment_input",
  "work_start",
  "work_revise",
  "work_step",
  "work_evidence",
  "work_yield",
  "work_cancel",
  "memory_set",
  "skill_draft",
  "skill_evaluate",
  "skill_activate",
  // Agents read only their own pinned skills, through the runner's skill_read.
  "skill_read",
]);
const OPERATIONS = new Set(
  action.options.map((o) => o.shape.operation.value as string),
);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function contentHash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Text-only subset of Agent Skills frontmatter; unsupported YAML gets an explicit error. */
function skillMetadata(content: string, expectedName: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match)
    throw new Error("Plugin compatibility: SKILL.md requires frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description): ([^\r\n]+)$/.exec(line);
    if (!field || fields[field[1]!])
      throw new Error(
        "Plugin compatibility: skill frontmatter supports one-line name and description only",
      );
    fields[field[1]!] = field[2]!;
  }
  if (
    fields.name !== expectedName ||
    !fields.description ||
    fields.description.length > 1024 ||
    /^[|>"']/.test(fields.description)
  )
    throw new Error(
      "Plugin compatibility: skill name must match its directory; description must be plain single-line text",
    );
  return fields.description;
}
export function validateBundle(raw: unknown): PluginBundle {
  if (Buffer.byteLength(JSON.stringify(raw, null, 2)) + 1 > 256000)
    throw new Error("Plugin compatibility: bundle exceeds 256 KB");
  const bundle = bundleSchema.parse(raw);
  const { manifest: m, files } = bundle;
  if (
    Object.values(files).some((content) => Buffer.byteLength(content) > 32000)
  )
    throw new Error(
      "Plugin compatibility: Markdown files must be at most 32000 UTF-8 bytes",
    );
  unique(
    m.agents.map((a) => a.id),
    "agents",
  );
  unique(
    m.skills.map((s) => s.id),
    "skills",
  );
  const referenced = new Set<string>();
  for (const a of m.agents) {
    if (a.instructions !== `agents/${a.id}.md`)
      throw new Error(
        "Plugin compatibility: instructions must be agents/<id>.md",
      );
    unique(a.tools, "tools");
    unique(a.skills, "agent skills");
    if (a.skills.some((key) => !m.skills.some((s) => s.id === key)))
      throw new Error("Plugin compatibility: missing skill dependency");
    referenced.add(a.instructions);
  }
  for (const s of m.skills) {
    if (s.path !== `skills/${s.id}/SKILL.md`)
      throw new Error("Plugin compatibility: skill path must match its ID");
    referenced.add(s.path);
    skillMetadata(files[s.path] ?? "", s.id);
  }
  if (
    Object.keys(files).length !== referenced.size ||
    Object.keys(files).some((k) => !referenced.has(k)) ||
    [...referenced].some((k) => !files[k]?.trim())
  )
    throw new Error(
      "Plugin compatibility: only declared nonempty agent/skill Markdown files are supported; missing files, scripts and hooks are not supported",
    );
  return bundle;
}
function safeRead(root: string, relative: string, max: number) {
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep))
    throw new Error("Plugin compatibility: path outside package");
  let current = root;
  for (const part of relative.split("/")) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Plugin compatibility: symlinks are unsupported");
  }
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > max)
    throw new Error("Plugin compatibility: file is oversized or not regular");
  return readFileSync(target, "utf8");
}
export function readBundle(directory: string): PluginBundle {
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Plugin compatibility: package symlinks are unsupported");
  const root = realpathSync(directory);
  const manifest = pluginManifest.parse(
    JSON.parse(safeRead(root, "plugin.json", 32000)),
  );
  const paths = [
    ...manifest.agents.map((a) => a.instructions),
    ...manifest.skills.map((s) => s.path),
  ];
  // Validate expected paths before any content read.
  for (const path of paths)
    if (!/^(agents\/[a-z0-9-]+\.md|skills\/[a-z0-9-]+\/SKILL\.md)$/.test(path))
      throw new Error("Plugin compatibility: unsupported content path");
  const allowed = new Set(["plugin.json", ...paths]);
  let entries = 0;
  function inspect(relative = "") {
    for (const entry of readdirSync(resolve(root, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (++entries > 100 || entry.isSymbolicLink())
        throw new Error(
          "Plugin compatibility: excessive files or symlinks are unsupported",
        );
      if (
        entry.isDirectory() &&
        [...allowed].some((path) => path.startsWith(name + "/"))
      )
        inspect(name);
      else if (!entry.isFile() || !allowed.has(name))
        throw new Error(
          "Plugin compatibility: undeclared package files are unsupported: " +
            name,
        );
    }
  }
  inspect();
  return validateBundle({
    format: "companion.plugin-bundle/v1",
    manifest,
    files: Object.fromEntries(paths.map((p) => [p, safeRead(root, p, 32000)])),
  });
}
/** An immutable startup snapshot. Installation/config edits require a reviewed restart. */
export class PluginRegistry {
  private agents = new Map<string, PluginAgent>();
  private skillMap = new Map<string, PluginSkill>();
  readonly researchAgent: string | null;
  constructor(directory: string) {
    const root = realpathSync(directory);
    const config = registrySchema.parse(
      JSON.parse(safeRead(root, "registry.json", 32000)),
    );
    this.researchAgent = config.researchAgent;
    unique(
      config.enabled.map((e) => e.path),
      "enabled packages",
    );
    const plugins = new Set<string>();
    for (const enabled of config.enabled) {
      const bundle = readBundle(resolve(root, enabled.path));
      const hash = contentHash(bundle),
        m = bundle.manifest;
      if (hash !== enabled.sha256)
        throw new Error(
          `Plugin compatibility: content hash mismatch for ${m.id}; review and explicitly pin the package`,
        );
      if (plugins.has(m.id))
        throw new Error("Plugin compatibility: duplicate plugin identity");
      plugins.add(m.id);
      unique(enabled.agents, "enabled agents");
      if (enabled.agents.some((id) => !m.agents.some((a) => a.id === id)))
        throw new Error("Plugin compatibility: enabled agent not found");
      for (const s of m.skills) {
        const key = `${m.id}/${s.id}`;
        this.skillMap.set(key, {
          key,
          version: `plugin:${m.version}:${hash}`,
          reason: "Versioned plugin default",
          description: skillMetadata(bundle.files[s.path]!, s.id),
          content: bundle.files[s.path]!,
        });
      }
      for (const a of m.agents.filter((a) => enabled.agents.includes(a.id))) {
        if (a.tools.some((t) => !enabled.allowTools.includes(t)))
          throw new Error(
            `Plugin compatibility: host has not granted required tools for ${m.id}/${a.id}`,
          );
        const refused = a.tools.filter(
          (t) => !OPERATIONS.has(t) || NEVER_GRANTED.has(t),
        );
        if (refused.length)
          throw new Error(
            `Plugin compatibility: ${m.id}/${a.id} requests tools no agent can have: ${refused.join(", ")}`,
          );
        if (
          a.contract === "media/v1" &&
          a.tools.some((t) => t !== "source_read")
        )
          throw new Error(
            "Plugin compatibility: media/v1 agents may only read stored sources",
          );
        const agentId = `${m.id}/${a.id}`;
        this.agents.set(agentId, {
          ...a,
          agentId,
          pluginId: m.id,
          pluginVersion: m.version,
          pluginHash: hash,
          ...(enabled.model ? { hostModel: enabled.model } : {}),
          instructions: bundle.files[a.instructions]!,
          skillDefinitions: a.skills.map((id) =>
            this.skillMap.get(`${m.id}/${id}`)!,
          ),
        });
      }
    }
    if (
      JSON.stringify(this.catalogue()).length > 12000 ||
      this.skillMap.size > 32
    )
      throw new Error(
        "Plugin compatibility: enabled catalogue is too large; enable fewer packages",
      );
    if (this.researchAgent && !this.agents.has(this.researchAgent))
      throw new Error(
        "Plugin compatibility: research alias references a disabled or missing agent",
      );
    this.delegated = config.delegated ?? [];
    for (const op of this.delegated)
      if (![...this.agents.values()].some((a) => a.tools.includes(op)))
        throw new Error(
          `Plugin compatibility: delegated operation ${op} is not a tool of any enabled agent`,
        );
    this.aliases = {
      ...(this.researchAgent ? { research: this.researchAgent } : {}),
      ...(config.aliases ?? {}),
    };
    const targets = Object.values(this.aliases);
    if (new Set(targets).size !== targets.length)
      throw new Error(
        "Plugin compatibility: each agent can have only one alias",
      );
    for (const [alias, target] of Object.entries(this.aliases))
      if (!this.agents.has(target) || this.agents.has(alias))
        throw new Error(
          `Plugin compatibility: alias ${alias} must name an enabled agent and not shadow one`,
        );
  }
  readonly aliases: Record<string, string>;
  private delegated: string[] = [];
  /**
   * Operations to withhold from the coordinator. One is withheld only while an agent that can
   * use it is in the catalogue, so a disconnected agent never strands its tools.
   */
  delegatedOperations(catalogue: { tools: string[] }[]) {
    const reachable = new Set(catalogue.flatMap((a) => a.tools));
    return new Set(this.delegated.filter((op) => reachable.has(op)));
  }
  get(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("Plugin validation: agent is not enabled");
    return structuredClone(agent);
  }
  /** The agent ID for a type the coordinator names: an alias or a full plugin/agent ID. */
  resolve(type: string) {
    const agentId = this.aliases[type] ?? type;
    if (!this.agents.has(agentId))
      throw new Error(
        `Agent validation: unknown agent type "${type}"; use a type from agentCatalogue`,
      );
    return agentId;
  }
  /** What the coordinator can invoke with agent_run, one entry per type. */
  agentCatalogue(available: ReadonlySet<string>) {
    const names = new Map(
      Object.entries(this.aliases).map(([alias, id]) => [id, alias]),
    );
    return [...this.agents.values()]
      .filter(
        (a) => a.invocable !== false && a.tools.every((t) => available.has(t)),
      )
      .map((a) => ({
        type: names.get(a.agentId) ?? a.agentId,
        description: a.description,
        tools: a.tools,
        model: a.model ?? null,
        effort: a.effort ?? null,
      }));
  }
  catalogue() {
    return structuredClone(
      [...this.agents.values()].map((a) => ({
        agentId: a.agentId,
        description: a.description,
        pluginVersion: a.pluginVersion,
        pluginHash: a.pluginHash,
        requiredTools: a.tools,
        skills: a.skillDefinitions.map(({ content, ...s }) => s),
      })),
    );
  }
  skills() {
    return structuredClone([...this.skillMap.values()]);
  }
}
