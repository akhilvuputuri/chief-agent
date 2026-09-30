/**
 * SQL for "this run or an agent run it started". A domain agent's approvals and records carry
 * its own child run ID, so anything the coordinator reports for its turn must include them.
 * The parent records each child it starts (agent.started, research.started) under its own run,
 * so this uses the events(run_id) index. $1 is the owner; runParam is the coordinator's run.
 */
export function runFamily(runParam = "$2") {
  return `(SELECT ${runParam}::uuid UNION SELECT (e.data->>'childRunId')::uuid FROM events e WHERE e.run_id=${runParam}::uuid AND e.user_id=$1 AND e.type IN ('agent.started','research.started'))`;
}
