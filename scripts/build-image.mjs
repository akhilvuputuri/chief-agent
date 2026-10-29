// Image build: transpiles TypeScript to the same dist layout as `tsc`, without type
// checking. Releases run only after CI's `typecheck` passed, and `isolatedModules`
// plus `verbatimModuleSyntax` make tsc reject any file that would not transpile
// the same on its own.
import { build } from "esbuild";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packages = [
  { src: "coding_runtime_pi/src", out: "coding_runtime_pi/dist" },
  { src: "src", out: "dist" },
];

export function entries(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => join(dir, f));
}

export async function transpile({ src, out }) {
  await build({
    entryPoints: entries(src),
    outdir: out,
    outbase: src,
    format: "esm",
    platform: "node",
    target: "es2023",
    logLevel: "warning",
  });
}

// Run directly (not imported by the test). Real paths, so a symlinked or spaced path
// still builds instead of silently doing nothing.
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  for (const pkg of packages) await transpile(pkg);
}
