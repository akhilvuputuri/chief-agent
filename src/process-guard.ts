// Imported first by main.ts so it is installed before any startup code runs.
// Node's default handlers print the error message and stack to stderr, which
// is shipped off-host with the rest of the gateway output. Record only the error
// identity and code location, then exit as Node would.
import { errorFields, opsLog } from "./ops-log.js";

let exiting = false;
function fatal(event: string, error: unknown) {
  if (exiting) return;
  exiting = true;
  opsLog(event, "error", errorFields(error));
  process.exit(1);
}
process.on("uncaughtException", (error, origin) =>
  fatal(
    origin === "unhandledRejection"
      ? "process.unhandled_rejection"
      : "process.uncaught_exception",
    error,
  ),
);
process.on("unhandledRejection", (reason) =>
  fatal("process.unhandled_rejection", reason),
);
