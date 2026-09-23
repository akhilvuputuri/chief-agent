import { readFileSync } from "node:fs";
import { z } from "zod";

const schema = z
  .object({
    schemaVersion: z.literal(1),
    // Null preserves the existing AGENT_MODEL value until a reviewed PR chooses a model.
    main: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/)
      .nullable(),
  })
  .strict();

export type ModelPolicy = z.infer<typeof schema>;

export function readModelPolicy(
  url: URL = new URL("../config/model-policy.json", import.meta.url),
): ModelPolicy {
  try {
    return schema.parse(JSON.parse(readFileSync(url, "utf8")));
  } catch (error) {
    throw new Error("Invalid bundled model policy", { cause: error });
  }
}

export function resolveMainModel(
  environmentModel: string,
  policy: ModelPolicy = readModelPolicy(),
): string {
  return policy.main ?? environmentModel;
}
