import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packages, transpile } from "./build-image.mjs";

const jsFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"))
    .sort();

// `kite run test` builds with tsc first, so dist/ holds tsc's output to compare with.
test(
  "the image build emits the same JavaScript files as tsc",
  { skip: !existsSync("dist") && "run kite run build first" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "chief-image-build-"));
    try {
      for (const pkg of packages) {
        const out = join(root, pkg.out);
        await transpile({ src: pkg.src, out });
        assert.deepEqual(
          jsFiles(out),
          jsFiles(pkg.out),
          `${pkg.src}: esbuild and tsc emit different files`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
