import { z } from "zod";
import { bootStageNames } from "./boot-stages.js";

/** One kind of boxed work: what runs, where, and how long a box may live. */
export const boxProfile = z
  .object({
    provider: z.string().min(1).max(40),
    image: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
    /**
     * Earlier images a box of this profile may still be started with, for work snapshotted
     * before the latest re-pin (each must be box-capable). New work uses `image`.
     */
    previousImages: z
      .array(z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/))
      .max(10)
      .optional(),
    idleTtlMinutes: z.number().int().min(0).max(240),
    retentionHours: z.number().int().min(0).max(168),
    hardMaxHours: z.number().int().min(1).max(72),
    absoluteDays: z.number().int().min(1).max(30),
    concurrency: z.number().int().min(1).max(20),
  })
  .strict();
export type BoxProfile = z.infer<typeof boxProfile>;

export const boxConfig = z
  .object({
    /** Tags every resource; a sweep only ever touches its own environment. */
    environment: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    profiles: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), boxProfile),
  })
  .strict();
export type BoxConfig = z.infer<typeof boxConfig>;

const bounded = z
  .record(z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= 64000,
    "Payload too large",
  );

/** Events a box agent may report. Anything else is refused. */
export const boxEvent = z.discriminatedUnion("kind", [
  z.object({
    seq: z.number().int().nonnegative(),
    kind: z.literal("box.state"),
    state: z.enum(["idle", "busy"]),
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    kind: z.enum(["task.started", "task.progress", "task.question"]),
    taskId: z.string().uuid(),
    payload: bounded.default({}),
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    kind: z.enum(["task.result", "task.failed"]),
    taskId: z.string().uuid(),
    payload: bounded,
  }),
]);
export type BoxEvent = z.infer<typeof boxEvent>;

export const eventBatch = z
  .object({
    epoch: z.number().int().positive(),
    events: z.array(boxEvent).min(1).max(50),
  })
  .strict();

export const helloRequest = z
  .object({
    protocol: z.literal(1),
    /** The bootstrap secret (epoch 0) or the stored session credential. */
    credential: z.string().min(16).max(200),
    /** Provider identity proof, such as the EC2 instance identity document. */
    identity: z.unknown().optional(),
    /** First hello only: when each boot script stage finished. Timing metadata only. */
    bootStages: z
      .array(
        z
          .object({
            stage: z.enum(bootStageNames),
            atMs: z.number().int().positive().max(9_999_999_999_999),
          })
          .strict(),
      )
      .max(bootStageNames.length)
      .optional(),
  })
  .strict();
