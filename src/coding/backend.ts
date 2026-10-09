import { z } from "zod";
import { codingSettings } from "./schema.js";
export const codingBackend = z
  .object({ default: z.enum(["legacy", "pi"]) })
  .strict();
export function selectCodingBackend(
  selector: unknown,
  legacy: unknown,
  pi: unknown,
) {
  const backend = codingBackend.parse(selector).default;
  const legacySettings = codingSettings.parse(legacy);
  const settings = codingSettings.parse(backend === "pi" ? pi : legacy);
  if (backend === "pi" && settings.runtime !== "pi")
    throw new Error("Pi selection needs the Pi profile");
  if (backend === "legacy" && settings.runtime === "pi")
    throw new Error("Legacy profile cannot select Pi");
  if (settings.repository !== legacySettings.repository)
    throw new Error(
      "Backend cutover must preserve the configured repository for legacy jobs",
    );
  if (!settings.image)
    throw new Error("Selected coding backend needs a verified immutable image");
  return settings;
}
