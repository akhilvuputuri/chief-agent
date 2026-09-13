import { z } from "zod";
const label = z.string().min(1).max(160);
const prose = z.string().max(12000);
const base = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), title: label };
const entry = z.object({ title: label, body: prose }).strict();
export const canvasBlock = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("text"), body: prose }).strict(),
  z.object({ ...base, type: z.literal("details"), body: prose }).strict(),
  z
    .object({
      ...base,
      type: z.literal("cards"),
      items: z.array(entry).min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("timeline"),
      items: z
        .array(entry.extend({ when: label }))
        .min(1)
        .max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("table"),
      columns: z.array(label).min(1).max(8),
      rows: z.array(z.array(z.string().max(2000)).min(1).max(8)).max(200),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("chart"),
      unit: z.string().max(50),
      points: z
        .array(
          z
            .object({ label, value: z.number().finite().min(0).max(1e12) })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
]);
export const canvasDocument = z
  .object({
    schemaVersion: z.literal(1),
    title: label,
    summary: z.string().max(2000),
    blocks: z.array(canvasBlock).min(1).max(30),
    sources: z
      .array(
        z
          .object({
            label,
            url: z
              .string()
              .url()
              .max(2000)
              .regex(/^https?:\/\//i),
            sourceId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (new Set(d.blocks.map((b) => b.id)).size !== d.blocks.length)
      ctx.addIssue({ code: "custom", message: "Block IDs must be unique" });
    if (
      d.blocks.some(
        (b) =>
          b.type === "table" &&
          b.rows.some((r) => r.length !== b.columns.length),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Every table row must match its columns",
      });
    if (Buffer.byteLength(JSON.stringify(d)) > 100000)
      ctx.addIssue({
        code: "custom",
        message:
          "Canvas must fit within 100 KB; split larger content into separate canvases",
      });
  });
export const canvasCreate = z
  .object({
    operation: z.literal("canvas_create"),
    requestKey: z.string().uuid(),
    document: canvasDocument,
  })
  .strict();
export const canvasUpdate = z
  .object({
    operation: z.literal("canvas_update"),
    id: z.string().uuid(),
    baseRevision: z.number().int().positive(),
    requestKey: z.string().uuid(),
    document: canvasDocument,
  })
  .strict();
export const canvasRead = z
  .object({
    operation: z.literal("canvas_read"),
    id: z.string().uuid(),
    revision: z.number().int().positive().optional(),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const canvasList = z
  .object({
    operation: z.literal("canvas_list"),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export type CanvasDocument = z.infer<typeof canvasDocument>;
export type CanvasWrite =
  z.infer<typeof canvasCreate> | z.infer<typeof canvasUpdate>;
export const canvasRef = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive().optional(),
  })
  .strict();
