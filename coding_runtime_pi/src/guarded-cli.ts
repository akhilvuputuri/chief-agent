import { linuxProcessBoundary } from "./process-boundary.js";
linuxProcessBoundary("/opt/pi-runtime/process-boundary.node");
await import("./cli.js");
