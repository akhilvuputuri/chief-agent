import { readFileSync } from "node:fs";
import { z } from "zod";
import { boxProfile, type BoxConfig } from "./schema.js";
import type { Ec2Settings } from "./ec2-provider.js";

const name = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);

const ec2Profile = z
  .object({
    launchTemplate: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
    taskMemory: z.string().optional(),
    taskCpus: z.string().optional(),
    taskCommand: z.array(z.string()).max(8).optional(),
  })
  .strict();

/** config/boxes.json: reviewed, versioned box profiles and their EC2 launch settings. */
export const boxesFile = z
  .object({
    environment: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    profiles: z.record(name, boxProfile),
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
