/**
 * SQL for "this run or an agent run it started". A domain agent's approvals and records carry
 * its own child run ID, so anything the coordinator reports for its turn must include them.
 * $1 is the owner and the given placeholder is the coordinator's run ID.
 */
export function runFamily(runParam = "$2") {
  return `(SELECT ${runParam}::uuid UNION SELECT e.run_id FROM events e WHERE e.user_id=$1 AND e.type IN ('agent.child_started','research.child_started') AND e.data->>'parentRunId'=${runParam}::text)`;
}
