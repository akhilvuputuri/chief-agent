import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * A migration merged without its Compose line and rollout script makes every later release
 * refuse to run (scripts/cloud-release.py compares db/ and compose.yaml with the live host).
 * Rollout scripts name their migration as MIGRATION = '<file>' from 032 on; 031 has none.
 */
test("every migration has its Compose line, and new ones a rollout script with a test", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  const scripts = readdirSync("scripts");
  const deploys = scripts.filter((f) => /^deploy-.+\.py$/.test(f));
  const migrations = readdirSync("db")
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const numbers = migrations.map((f) => Number(f.split("_")[0]));
  assert.equal(
    new Set(numbers).size,
    numbers.length,
    "duplicate migration number",
  );
  for (const file of migrations) {
    assert(
      compose.includes(`/migrations/${file}`),
      `${file} has no line in compose.yaml`,
    );
    if (Number(file.split("_")[0]) < 32) continue;
    // A script names the previous migration too, as its Compose anchor; only MIGRATION counts.
    const deploy = deploys.find((d) =>
      new RegExp(`^MIGRATION = '${file.replace(".", "\\.")}'$`, "m").test(
        readFileSync(`scripts/${d}`, "utf8"),
      ),
    );
    assert(deploy, `${file} has no scripts/deploy-*.py rollout script`);
    assert(
      scripts.includes(deploy.replace(/^deploy-/, "test-deploy-")),
      `scripts/${deploy} has no scripts/test-${deploy}`,
    );
  }
});
