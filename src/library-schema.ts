import { z } from "zod";
export const titleId = z.string().regex(/^\d{1,12}$/);
export const libraryCheck = z
  .object({
    operation: z.literal("library_check"),
    query: z.string().trim().min(2).max(200),
    author: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export const libraryAvailability = z
  .object({
    operation: z.literal("library_availability"),
    titleIds: z.array(titleId).min(1).max(5),
  })
  .strict();
export const libraryShelf = z
  .object({ operation: z.literal("library_shelf") })
  .strict();
export type LibraryAction =
  | z.infer<typeof libraryCheck>
  | z.infer<typeof libraryAvailability>
  | z.infer<typeof libraryShelf>;
