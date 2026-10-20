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
  "Generation recovery already used": "recovery_already_used",
  "Model call is already in flight": "model_call_duplicate",
  "Model request key conflict": "model_key_conflict",
  "Earlier model request is pending or uncertain; do not replay it":
    "model_replay_pending",
  "Exact model response unavailable; inspect before continuing":
    "model_response_unavailable",
  "Generation recovery parent or payload does not match":
    "recovery_parent_mismatch",
  "Invalid generation recovery parent": "recovery_parent_invalid",
  "Invalid per-call output allowance": "output_allowance_invalid",
  "Invalid model request purpose": "purpose_invalid",
  "Leader role requires the reviewed squad runtime": "leader_role_invalid",
  "Coding request cancelled before model dispatch": "cancelled_before_dispatch",
  "Native Pi endpoint requires a Pi job": "pi_endpoint_mismatch",
  "Conflicting native output limits": "output_limits_conflict",
  "Reviewer model requires approved implementation": "reviewer_too_early",
  "Model is not the job's pinned role selection": "model_not_pinned",
  "Worker attempt superseded": "attempt_superseded",
  "Progress key conflict": "progress_key_conflict",
};

export function rejectionReason(error: unknown) {
  return (error instanceof Error && reasons[error.message]) || "unclassified";
}
