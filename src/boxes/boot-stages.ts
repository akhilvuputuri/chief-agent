// No imports: the box agent runs from a bare copy of dist/boxes, without node_modules.

/** The stages the EC2 boot script stamps, in order (ec2-provider.ts). */
export const bootStageNames = [
  "script_started",
  "docker_installed",
  "docker_started",
  "image_pulled",
  "agent_copied",
  "agent_starting",
] as const;

export type BootStageName = (typeof bootStageNames)[number];

/**
 * Parses the boot script's stage file. Timing only, so anything missing or malformed is
 * dropped: this must never stop a box from starting.
 */
export function parseBootStages(text: string) {
  const known = new Set<string>(bootStageNames);
  const stages = new Map<BootStageName, number>();
  for (const line of text.split("\n")) {
    const match = /^([a-z_]+) (\d{10,13})$/.exec(line.trim());
    if (match && known.has(match[1]!))
      stages.set(match[1] as BootStageName, Number(match[2]));
  }
  return [...stages].map(([stage, atMs]) => ({ stage, atMs }));
}
