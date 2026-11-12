import type { CodingSettings } from "./schema.js";

/**
 * A Pi job's settings on the worker image new jobs use, or nothing when the job cannot move
 * (not Pi, or no current Pi image). Only the image changes: models, limits and context
 * windows stay, and saved work is kept. The current image is the reviewed one the coding
 * boxes accept. Used by `coding_job_update` (`upgradeWorker`) and by the automatic rebase
 * (journal 174), because current main may need the newer image's toolchain.
 */
export function currentWorker(
  job: CodingSettings,
  profile: Pick<CodingSettings, "runtime" | "image">,
): CodingSettings | undefined {
  if (job.runtime !== "pi" || profile.runtime !== "pi" || !profile.image)
    return undefined;
  return { ...job, image: profile.image };
}
