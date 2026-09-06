import { readFileSync } from "node:fs";
const keys = ["research", "synthesis", "task-execution", "personal-assistance"];
export const baselineSkills = keys.map((key) => ({
  key,
  version: `repo:${key}:1`,
  reason: "Versioned repository default",
  content: readFileSync(
    new URL(`../skills/${key}/SKILL.md`, import.meta.url),
    "utf8",
  ),
}));
