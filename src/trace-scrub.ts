/** Best effort credential filtering. Source content remains private even after scrubbing. */
export function scrubTrace(value: unknown): any {
  if (typeof value === "string")
    return value
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,}|\d{7,12}:[A-Za-z0-9_-]{25,}|1\/\/[A-Za-z0-9_-]{20,})\b/g,
        "[REDACTED_CREDENTIAL]",
      )
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED_CREDENTIAL]");
  if (Array.isArray(value)) return value.map(scrubTrace);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /^(authorization|password|api_?key|client_secret|access_token|refresh_token)$/i.test(
          key,
        )
          ? "[REDACTED_CREDENTIAL]"
          : scrubTrace(v),
      ]),
    );
  return value;
}
