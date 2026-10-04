import type { Destination } from "../delivery-routing.js";
import { workerEvent } from "./schema.js";

/** Only validated worker progress belongs in Coding; owner decisions stay in General. */
export function codingDestination(payload: unknown): Destination {
  return workerEvent.safeParse(payload).success
    ? { kind: "topic", topic: "coding" }
    : { kind: "general" };
}
