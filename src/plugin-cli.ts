import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  contentHash,
  PluginRegistry,
  readBundle,
  validateBundle,
} from "./plugins.js";

/** Operator-only tooling. Import writes text files; it never enables or executes a package. */
export function pluginCommand(command: string, input: string, output?: string) {
  if (command === "registry")
    return new PluginRegistry(resolve(input)).catalogue();
  if (command === "validate" || command === "export") {
    const bundle = readBundle(resolve(input));
    if (command === "export") {
      if (!output) throw new Error("export requires a new output bundle path");
      writeFileSync(output, JSON.stringify(bundle, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    return {
      id: bundle.manifest.id,
      version: bundle.manifest.version,
      sha256: contentHash(bundle),
      ...(output ? { output } : {}),
    };
  }
  if (command === "import") {
    if (!output) throw new Error("import requires a new destination directory");
    const stat = lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000)
      throw new Error(
        "Import requires a regular bundle file no larger than 256 KB",
      );
    const bundle = validateBundle(JSON.parse(readFileSync(input, "utf8")));
    const target = resolve(output);
    if (existsSync(target))
      throw new Error(
        "Import destination already exists; choose a new version directory",
      );
    const staging = mkdtempSync(join(dirname(target), ".plugin-import-"));
    try {
      writeFileSync(
        join(staging, "plugin.json"),
        JSON.stringify(bundle.manifest, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      for (const [path, content] of Object.entries(bundle.files)) {
        const destination = join(staging, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
      }
      renameSync(staging, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return {
      id: bundle.manifest.id,
      version: bundle.manifest.version,
      sha256: contentHash(bundle),
      output: target,
      enabled: false,
      next: "Review the package, then explicitly add its path/hash, agent IDs and tool grants to plugins/registry.json.",
    };
  }
  throw new Error(
    "Usage: plugins <validate|export|import|registry> <input> [output]",
  );
}
if (process.argv[1] && /plugin-cli\.(ts|js)$/.test(process.argv[1])) {
  try {
    const [, , command, input, output] = process.argv;
    console.log(
      JSON.stringify(
        pluginCommand(command ?? "", input ?? "", output),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Plugin operation failed",
    );
    process.exitCode = 1;
  }
}
