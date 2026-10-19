import { readFileSync } from "node:fs";
import { z } from "zod";
import { boxProfile, type BoxConfig } from "./schema.js";
import { launchPatterns, type Ec2Settings } from "./ec2-provider.js";

const name = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

// The same patterns the first-boot script enforces, so a bad value fails at startup rather
// than at every launch.
const ec2Profile = z
  .object({
    launchTemplate: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
    taskMemory: z.string().regex(launchPatterns.memory).optional(),
    taskCpus: z.string().regex(launchPatterns.cpus).optional(),
    taskCommand: z
      .array(z.string().regex(launchPatterns.argument))
      .min(1)
      .max(8)
      .optional(),
  })
  .strict();

/** config/boxes.json: reviewed, versioned box profiles and their EC2 launch settings. */
export const boxesFile = z
  .object({
    environment: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    profiles: z.record(
      name,
      boxProfile.refine((p) => launchPatterns.image.test(p.image), {
        message: "Box images must be digest-pinned",
      }),
    ),
    ec2: z.record(name, ec2Profile),
  })
  .strict()
  .superRefine((file, ctx) => {
    for (const [profile, settings] of Object.entries(file.profiles))
      if (settings.provider === "ec2" && !file.ec2[profile])
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `EC2 profile ${profile} has no launch settings`,
        });
  });
export type BoxesFile = z.infer<typeof boxesFile>;

export function loadBoxesFile(url: URL): BoxesFile {
  return boxesFile.parse(JSON.parse(readFileSync(url, "utf8")));
}

export function boxSettings(file: BoxesFile, accountId: string) {
  if (!/^\d{12}$/.test(accountId))
    throw new Error("Boxes need the 12-digit AWS account ID");
  const config: BoxConfig = {
    environment: file.environment,
    profiles: file.profiles,
  };
  const ec2: Ec2Settings = {
    region: file.region,
    accountId,
    profiles: file.ec2,
  };
  return { config, ec2 };
}

/** The public origin a box dials; validated at startup with the first-boot pattern. */
export function boxOrigin(origin: string) {
  if (!launchPatterns.origin.test(origin))
    throw new Error(
      "CODING_PUBLIC_ORIGIN must be an https origin without a path",
    );
  return origin;
}
