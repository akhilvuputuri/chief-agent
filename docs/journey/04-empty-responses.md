# 04 — Recovering from an unusable model response

Incident: 8 September 2026. Status: released at `0ef13bc`.

A simple role-count request failed after one model call and zero tools. The adapter treated no usable text/tool calls as permanent failure. Because the original response was not retained, we could not retrospectively distinguish an error envelope from an empty successful response. The saved records were unaffected.

We added classification for provider error envelopes, bounded retries for transient blank/429/5xx responses, and safe structural diagnostics. Exhaustion/filtering remains non-retryable; rejected responses dispatch no tools. Existing budgets bound retries, and unavailable cost remains unknown.

[The incident and regression coverage](../model-response-recovery.md) documents the evidence. The lesson is to improve recovery and observability without claiming we identified an upstream cause absent from the trace. A retry mechanism is not proof the provider failure disappeared.
