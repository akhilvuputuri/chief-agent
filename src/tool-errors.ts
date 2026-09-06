import { ZodError } from "zod";
export function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
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
