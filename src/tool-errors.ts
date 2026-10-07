/** Host validation stopped an invocation before entering the tool dispatcher. */
export class NotDispatchedError extends Error {
  constructor(readonly reason: "interrupted" | "cancelled") {
    super(
      reason === "cancelled"
        ? "Task cancelled"
        : "New input superseded this invocation",
    );
  }
}
import { ZodError } from "zod";
import { McpFailure } from "./mcp-errors.js";
/** This call form already failed the same way in consecutive steps of the run; it was not dispatched. */
export class RepeatedFailureError extends Error {
  constructor(operation: string, code: string, count: number) {
    super(
      `${operation} failed the same way (${code}) in ${count} steps of this request with no success in between, so this call with the same argument names was not made. Do not retry it in this request: use another form (for example listing without an id), answer with what you have, or ask the owner.`,
    );
  }
}
/** The host has established that this invocation made no domain mutation. */
export class ToolValidationError extends Error {}
export function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof McpFailure)
    return {
      code:
        error.category === "auth"
          ? "AUTHORIZATION_REQUIRED"
          : error.category === "permission"
            ? "PERMISSION_DENIED"
            : error.category === "invalid"
              ? "INVALID_INPUT"
              : error.category === "capacity"
                ? "RATE_LIMITED"
                : "TOOL_FAILED",
      retryable: false,
      message:
        error.category === "auth"
          ? "Reconnect the MCP connection before retrying."
          : error.category === "capacity"
            ? "MCP capacity limit; honour retryAfterSeconds or request owner action."
            : "MCP operation failed; inspect its durable state before retrying a write.",
      retryAfterSeconds: error.retryAfterSeconds,
    };
  if (error instanceof ToolValidationError)
    return { code: "VALIDATION_FAILED", retryable: false, message };
  if (error instanceof RepeatedFailureError)
    return { code: "REPEATED_FAILURE", retryable: false, message };
  if (error instanceof ZodError)
    return {
      code: "INVALID_INPUT",
      retryable: false,
      message:
        "Correct the fields: " +
        error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ")
          .slice(0, 1200),
    };
  if (message.startsWith("Result recording failed"))
    return { code: "RESULT_UNRECORDED", retryable: false, message };
  const known = [
    /^Research validation:/,
    /^Plugin validation:/,
    /^Skill validation:/,
    /^Canvas validation:/,
    /^Media validation:/,
    /^Agent validation:/,
    /Only a user follow-up can revise scope/,
    /uncertain write requires inspection/,
    /Task cancelled/,
    /Task paused for cutover/,
    /Quote must appear/,
    /Source not found/,
    /Task scope changed/,
    /Task unavailable/,
    /Step not found/,
    /Proof does not belong/,
    /Matched source evidence required/,
    /Successful action receipt required/,
    /Analysis must link/,
    /Result required/,
    /Evaluate this exact draft/,
    /Unknown experience requires/,
    /A strength or confirmed gap requires/,
  ];
  if (known.some((r) => r.test(message)))
    return { code: "VALIDATION_FAILED", retryable: false, message };
  if (/not configured|not connected|setup is incomplete/i.test(message))
    return {
      code: "NOT_CONFIGURED",
      retryable: false,
      message: "This connection is not configured for the current user.",
    };
  if (
    /expired|authorization|credential|401|403|Wrong Google account/i.test(
      message,
    )
  )
    return {
      code: "AUTHORIZATION_REQUIRED",
      retryable: false,
      message:
        "Authorization is unavailable or expired; reconnect before retrying.",
    };
  if (/not found|unavailable|already used/i.test(message))
    return {
      code: "NOT_FOUND_OR_UNAVAILABLE",
      retryable: false,
      message:
        "The requested resource is unavailable or belongs to another scope.",
    };
  if (/duplicate key|work_one_active/i.test(message))
    return {
      code: "ACTIVE_WORK_EXISTS",
      retryable: false,
      message:
        "Inspect work_status and revise or cancel the current task before starting another.",
    };
  return {
    code: "TOOL_FAILED",
    retryable: false,
    message:
      "The tool failed. Inspect saved state before repeating writes; retry a read at most twice. Do not claim success.",
  };
}
