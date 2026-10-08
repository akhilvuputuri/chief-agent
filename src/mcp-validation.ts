import { Worker } from "node:worker_threads";
import { ToolValidationError } from "./tool-errors.js";

/** Bound compilation and regex execution off the gateway event loop. */
export async function validateMcpSchema(
  schema: Record<string, unknown>,
  data: unknown,
  signal?: AbortSignal,
) {
  const failure = () =>
    new ToolValidationError(
      "MCP arguments or discovered schema are invalid or exceeded validation limits; inspect mcp_tools",
    );
  if (signal?.aborted) throw failure();
  if (
    Buffer.byteLength(JSON.stringify(schema)) > 32000 ||
    Buffer.byteLength(JSON.stringify(data)) > 220000
  )
    throw failure();
  // npm test builds first; focused source tests use the same compiled worker as production.
  const url = new URL(
    import.meta.url.endsWith(".ts")
      ? "../dist/mcp-validator-worker.js"
      : "./mcp-validator-worker.js",
    import.meta.url,
  );
  const worker = new Worker(url, {
    workerData: { schema, data },
    stdout: true,
    stderr: true,
    env: {},
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 32,
      maxYoungGenerationSizeMb: 8,
      stackSizeMb: 2,
    },
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (valid: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        valid ? resolve() : reject(failure());
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), 2000);
      worker.once("message", (message) => finish(message?.valid === true));
      worker.once("error", () => finish(false));
      worker.once("exit", () => finish(false));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    await worker.terminate();
  }
}
