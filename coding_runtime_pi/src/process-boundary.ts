import { createRequire } from "node:module";
export function linuxProcessBoundary(path: string) {
  if (process.platform !== "linux")
    throw new Error("Disposable worker requires Linux isolation");
  const native = createRequire(import.meta.url)(path) as {
    lockdown: () => boolean;
    cleanup: () => void;
  };
  if (!native.lockdown()) throw new Error("Process isolation unavailable");
  return native.cleanup;
}
