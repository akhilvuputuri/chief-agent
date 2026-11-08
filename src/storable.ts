/**
 * Text Postgres text and jsonb accept: no NUL and no lone surrogates. Postgres refuses
 * both outright, so untrusted text (model replies, tool and command output) is made
 * storable before it is written. Use it only for descriptive copies; exact content such
 * as code or a hash-bound report document is refused instead of changed (see
 * `storableCheckpoint` in src/coding/controller.ts).
 */
export function storable<T>(value: T): T {
  if (typeof value === "string")
    return value
      .replace(/\u0000/g, "")
      .replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        "\ufffd",
      ) as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  // Plain data only (parsed JSON); keys too, since jsonb keys are text.
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [storable(k), storable(v)]),
    ) as T;
  return value;
}
