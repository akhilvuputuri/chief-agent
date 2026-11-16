import { z } from "zod";

/**
 * An array schema that checks its length before its elements, and stops at the first
 * element that fails.
 *
 * zod 3's `z.array(item).max(n)` validates every element even when the array is longer
 * than `n`, and keeps an issue for each element that fails. A body of millions of bad
 * elements then costs the process about 290 bytes each before it is refused
 * (GHSA-mrhx-c7xc-m3w5, journal 198). zod 4.6.6 fixed that by checking the length first;
 * this does the same on zod 3. Stopping at the first bad element also bounds an array
 * that declares no maximum, which zod 4 does not.
 *
 * It does not build on `z.array`: zod 3 allocates for every element of any array it
 * walks, even one of `z.unknown()`, before a length check can refuse it.
 *
 * A valid array parses to the same value as `z.array(item)`. An invalid one reports its
 * length, or its first bad element, and nothing after it. Its issues are fatal, so a
 * refinement on an enclosing object does not run against a value that was never parsed.
 */
export function boundedArray<T extends z.ZodTypeAny>(
  item: T,
  bounds: { min?: number; max?: number } = {},
) {
  return z.unknown().transform((value, ctx): z.output<T>[] => {
    if (!Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.invalid_type,
        expected: "array",
        received: z.getParsedType(value),
        fatal: true,
      });
      return z.NEVER;
    }
    if (bounds.min !== undefined && value.length < bounds.min) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        type: "array",
        minimum: bounds.min,
        inclusive: true,
        fatal: true,
      });
      return z.NEVER;
    }
    if (bounds.max !== undefined && value.length > bounds.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: bounds.max,
        inclusive: true,
        fatal: true,
      });
      return z.NEVER;
    }
    const parsed: z.output<T>[] = [];
    for (let index = 0; index < value.length; index++) {
      const result = item.safeParse(value[index]);
      if (!result.success) {
        for (const issue of result.error.issues)
          ctx.addIssue({
            ...issue,
            path: [index, ...issue.path],
            fatal: true,
          });
        return z.NEVER;
      }
      parsed.push(result.data);
    }
    return parsed;
  });
}
