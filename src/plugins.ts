import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";

const id = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(48);
const file = z
  .string()
  .regex(/^[a-zA-Z0-9_/-]+\.(md|json)$/)
  .max(160);
const reads = z.enum([
  "web_search",
  "web_read",
  "source_read",
  "parcel_email_read",
]);
const agent = z
  .object({
    id,
    description: z.string().min(1).max(600),
    instructions: file,
    contract: z.enum(["public-research/v1", "parcel-extraction/v1"]),
    tools: z.array(reads).min(1).max(3),
    skills: z.array(id).max(8),
    // These are host ceilings, not permissions a package can raise.
    limits: z
      .object({
        ms: z.number().int().min(1000).max(120000),
        models: z.number().int().min(1).max(8),
        tools: z.number().int().min(1).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const valid =
      a.contract === "public-research/v1"
        ? a.tools.every((t) => t !== "parcel_email_read")
        : a.tools.length === 1 && a.tools[0] === "parcel_email_read";
    if (!valid)
      ctx.addIssue({
        code: "custom",
        message: "Tools must match the host contract",
      });
  });
export const pluginManifest = z
  .object({
    format: z.literal("companion.plugin/v1"),
    id,
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(32),
    description: z.string().min(1).max(1000),
    agents: z.array(agent).max(8),
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
  model?: string;
  skillDefinitions: PluginSkill[];
};
const registrySchema = z
  .object({
    format: z.literal("companion.plugin-registry/v1"),
    researchAgent: z.string().max(100).nullable(),
    enabled: z
      .array(
        z
          .object({
            path: id,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            agents: z.array(id).max(8),
            allowTools: z.array(reads).max(3),
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
        const agentId = `${m.id}/${a.id}`;
        this.agents.set(agentId, {
          ...a,
          agentId,
          pluginId: m.id,
          pluginVersion: m.version,
          pluginHash: hash,
          ...(enabled.model ? { model: enabled.model } : {}),
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
    if (
      this.researchAgent &&
      this.agents.get(this.researchAgent)?.contract !== "public-research/v1"
    )
      throw new Error(
        "Plugin compatibility: research alias references a disabled or missing agent",
      );
  }
  get(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("Plugin validation: agent is not enabled");
    return structuredClone(agent);
  }
  catalogue() {
    return structuredClone(
      [...this.agents.values()].map((a) => ({
        agentId: a.agentId,
        contract: a.contract,
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
