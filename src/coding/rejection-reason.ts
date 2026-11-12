/**
 * A short, fixed reason for a refused worker request, so a "worker_request_rejected" can
 * be diagnosed from the job record. Only the host's own fixed messages are mapped; any
 * other error is "unclassified", so no free text (paths, provider replies) is stored.
 */
const reasons: Record<string, string> = {
  "Another model request is already in flight": "model_slot_busy",
  "Model allocation exhausted": "model_allocation_exhausted",
  "Coding attempt deadline has passed": "attempt_deadline_passed",
  "Coding attempt is no longer active": "attempt_inactive",
  "Model call is already in flight": "model_call_duplicate",
  "Model request key conflict": "model_key_conflict",
  "Earlier model request is pending or uncertain; do not replay it":
    "model_replay_pending",
  "Exact model response unavailable; inspect before continuing":
    "model_response_unavailable",
  "Invalid model request purpose": "purpose_invalid",
  "Leader role requires the reviewed squad runtime": "leader_role_invalid",
  "Coding request cancelled before model dispatch": "cancelled_before_dispatch",
  "Native Pi endpoint requires a Pi job": "pi_endpoint_mismatch",
  "Pi jobs use the Messages route": "pi_legacy_route",
  "Invalid Messages request": "messages_request_invalid",
  "Pi coding model has no direct Anthropic route": "model_not_direct",
  "Model effort differs from the job's effort": "effort_not_pinned",
  "Model request names fallback models or a speed": "model_option_refused",
  "Reviewer model requires approved implementation": "reviewer_too_early",
  "Model is not the job's pinned role selection": "model_not_pinned",
  "Worker attempt superseded": "attempt_superseded",
  "Progress key conflict": "progress_key_conflict",
  "Exact content is not storable text": "exact_content_not_storable",
};

export function rejectionReason(error: unknown) {
  if (error instanceof Error && reasons[error.message])
    return reasons[error.message];
  // Postgres data exceptions (SQLSTATE class 22) mean the host could not store a value.
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^22[0-9A-Z]{3}$/.test(code))
    return "database_value_rejected";
  return "unclassified";
}
