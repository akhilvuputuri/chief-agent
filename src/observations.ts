/** Model-facing projections; complete results remain in runtime_calls. */
export function projectObservation(
  operation: string,
  value: any,
  observationId?: string,
): any {
  const result = value?.result ?? value;
  let projected: any = result;
  if (operation === "finish_turn" && result?.answer) {
    projected = {
      recorded: true,
      sectionCount: result.answer.sections?.length ?? 0,
      recordCount: result.answer.records?.length ?? 0,
      notice:
        "Full answer envelope is stored. Use observation_read with this observationId and offsets for follow-ups.",
    };
  } else if (operation.startsWith("work_") && result?.task) {
    projected = compactWork(result);
  } else if (Array.isArray(result)) {
    projected = result.map((item) =>
      item && typeof item === "object" ? compactRecord(item) : item,
    );
  } else if (operation === "job_analyze" && result?.role) {
    projected = {
      role: compactRecord(result.role),
      instruction:
        "These are analysis inputs, not a completed assessment. Use explicit memories from current context; retrieve the full observation if needed.",
    };
  }
  // Trim payload fields before serialization so identifiers at the end survive.
  if (projected && !Array.isArray(projected) && typeof projected === "object") {
    projected = { ...projected };
    for (const key of ["content", "description", "text"]) {
      if (typeof projected[key] === "string" && projected[key].length > 8000) {
        projected[key] = projected[key].slice(0, 8000);
        projected.truncated = true;
      }
    }
  }
  const serialized = JSON.stringify(projected);
  if (serialized && serialized.length > 12000)
    projected = {
      ...(projected && !Array.isArray(projected)
        ? Object.fromEntries(
            [
              "id",
              "sourceId",
              "sourceUrl",
              "url",
              "revision",
              "total",
              "nextOffset",
            ]
              .filter((k) => projected[k] !== undefined)
              .map((k) => [k, projected[k]]),
          )
        : {}),
      excerpt: serialized.slice(0, 10000),
      truncated: true,
      notice:
        "Full result is stored. Use observation_read with observationId and offset to retrieve more.",
    };
  return {
    ...(value?.receiptId ? { receiptId: value.receiptId } : {}),
    ...(observationId ? { observationId } : {}),
    result: projected,
  };
}
function compactRecord(item: any) {
  const { user_id, created_at, updated_at, ...rest } = item;
  return {
    ...rest,
    ...(typeof rest.description === "string"
      ? {
          description: rest.description.slice(0, 200),
          descriptionTruncated: rest.description.length > 200,
        }
      : {}),
  };
}
export function compactWork(snapshot: any) {
  if (!snapshot) return null;
  return {
    task: {
      id: snapshot.task.id,
      revision: snapshot.task.revision,
      objective: snapshot.task.objective,
      request: snapshot.task.request,
      status: snapshot.task.status,
      pause_reason: snapshot.task.pause_reason,
    },
    counts: snapshot.counts,
    steps: snapshot.steps.map((s: any) => ({
      key: s.key,
      title: s.title,
      status: s.status,
      verification: s.verification,
      expected_operation: s.expected_operation,
      result: s.result.slice(0, 250),
    })),
    notice:
      "Compact current state. Work updates do not repeat receipt history. Read original observations for exact evidence.",
  };
}
