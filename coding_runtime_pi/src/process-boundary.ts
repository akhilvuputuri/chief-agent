import { createRequire } from "node:module";
let installedCleanup: (() => void) | undefined;
export function processCleanup() {
  return installedCleanup;
}
export function linuxProcessBoundary(path: string) {
  if (process.platform !== "linux")
    throw new Error("Disposable worker requires Linux isolation");
  const native = createRequire(import.meta.url)(path) as {
    lockdown: () => boolean;
    cleanup: () => void;
  };
  if (!native.lockdown()) throw new Error("Process isolation unavailable");
  installedCleanup = native.cleanup;
  return native.cleanup;
}
