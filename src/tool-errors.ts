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
  constructor(
    operation: string,
    code: string,
    count: number,
    identical = false,
  ) {
    super(
      identical
        ? `${operation} with these exact arguments was already refused (${code}) in ${count} steps of this request, and nothing has been written since, so it was not made again. Reads do not change why it was refused. Do not retry it: act on the reason given in the earlier result, answer with what you have, or ask the owner.`
        : `${operation} failed the same way (${code}) in ${count} steps of this request with no success in between, so this call with the same argument names was not made. Do not retry it in this request: use another form (for example listing without an id), answer with what you have, or ask the owner.`,
    );
  }
}
/** The host has established that this invocation made no domain mutation. */
export class ToolValidationError extends Error {}
/** An earlier write's outcome is uncertain, so this write was refused before any mutation. */
export class WriteBlockedError extends ToolValidationError {}
/**
 * The index or constraint a Postgres unique violation (SQLSTATE 23505) names, "" when
 * it names none, or undefined when this is not a unique violation.
 */
function uniqueViolation(error: unknown, message: string) {
  const fields = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (fields.code !== "23505" && !/duplicate key/i.test(message)) return;
  if (typeof fields.constraint === "string" && fields.constraint)
    return fields.constraint;
  return /unique constraint "([^"]+)"/.exec(message)?.[1] ?? "";
}
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
  if (error instanceof WriteBlockedError)
    return {
      code: "WRITE_BLOCKED",
      retryable: false,
      message:
        message.replace(/\.?$/, ".") +
        " No further writes run in this request. Do not retry: answer from what you have and tell the owner that a write is waiting on inspection.",
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
  // A unique violation names its index. Only work_one_active is about durable work tasks;
  // blaming work_status for another index sent the owner to cancel an unrelated task.
  const constraint = uniqueViolation(error, message);
  if (constraint === "coding_one_active_worker")
    return {
      code: "CODING_WORKER_BUSY",
      retryable: false,
      message:
        "Nothing changed: another coding job is using the single coding worker slot (running, publishing, or waiting for its sandbox cleanup). Wait for it to finish or cancel that coding job first; read coding_status to find it. This is not a work_status task.",
    };
  if (constraint?.startsWith("coding_"))
    return {
      code: "CODING_CONFLICT",
      retryable: false,
      message:
        "Nothing changed: a coding record with the same identity already exists. Read coding_status for the job and retry with its current revision or a new requestKey. This is not a work_status task.",
    };
  if (constraint === "work_one_active" || /work_one_active/.test(message))
    return {
      code: "ACTIVE_WORK_EXISTS",
      retryable: false,
      message:
        "Inspect work_status and revise or cancel the current task before starting another.",
    };
  if (constraint !== undefined)
    return {
      code: "DUPLICATE_RECORD",
      retryable: false,
      message:
        "Nothing changed: a record with the same identity already exists. Read its current state before retrying.",
    };
  return {
    code: "TOOL_FAILED",
    retryable: false,
    message:
      "The tool failed. Inspect saved state before repeating writes; retry a read at most twice. Do not claim success.",
  };
}
