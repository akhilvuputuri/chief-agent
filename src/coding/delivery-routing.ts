import type { Destination } from "../delivery-routing.js";

/** Everything about a coding job, including approvals, questions, results and merge cards, belongs in Coding. */
export function codingDestination(_payload: unknown): Destination {
  return { kind: "topic", topic: "coding" };
}
