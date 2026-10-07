export class McpFailure extends Error {
  constructor(
    readonly category:
      "auth" | "permission" | "invalid" | "capacity" | "uncertain" | "tool",
    readonly retryAfterSeconds?: number,
  ) {
    super(`MCP ${category} failure`);
  }
}
