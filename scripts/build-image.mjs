// Image build: transpiles TypeScript to the same dist layout as `tsc`, without type
// checking. Releases run only after CI's `typecheck` passed, and `isolatedModules`
// plus `verbatimModuleSyntax` make tsc reject any file that would not transpile
// the same on its own.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { join } from "node:path";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const pkg of packages) await transpile(pkg);
}
