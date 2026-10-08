import { z } from "zod";
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/);
const tool = z.string().min(1).max(128);
const argumentsSchema = z.record(z.unknown());
export const mcpTools = z
  .object({ operation: z.literal("mcp_tools"), connection: key.optional() })
  .strict();
export const mcpRead = z
  .object({
    operation: z.literal("mcp_read"),
    connection: key,
    tool,
    arguments: argumentsSchema,
  })
  .strict();
export const mcpWrite = z
  .object({
    operation: z.literal("mcp_write"),
    connection: key,
    tool,
    requestKey: z.string().uuid(),
    arguments: argumentsSchema.optional(),
    readerTarget: z.enum(["article", "discussion"]).optional(),
  })
  .strict();
export const mcpOperation = z
  .object({
    operation: z.literal("mcp_operation"),
    connection: key,
    requestKey: z.string().uuid(),
  })
  .strict();
export const mcpAction = z.discriminatedUnion("operation", [
  mcpTools,
  mcpRead,
  mcpWrite,
  mcpOperation,
]);
export type McpAction = z.infer<typeof mcpAction>;
