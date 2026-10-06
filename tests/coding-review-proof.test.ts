import { test } from "node:test";
import assert from "node:assert/strict";
import { completePlanDelivered } from "../src/coding/review-proof.js";
function page(offset: number, text: string, nextOffset: number | null) {
  return {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "page",
            function: {
              name: "plan_read",
              arguments: JSON.stringify({ offset }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "page",
        content: JSON.stringify({ text, nextOffset }),
      },
    ],
  };
}
test("review proof requires complete contiguous delivered pages, including codepoint offsets", () => {
  const plan = "😀ab界cd";
  assert(!completePlanDelivered([page(0, "😀ab", 3)], plan));
  assert(!completePlanDelivered([page(3, "界cd", null)], plan));
  assert(
    completePlanDelivered([page(0, "😀ab", 3), page(3, "界cd", null)], plan),
  );
  assert(
    !completePlanDelivered([page(0, "😀ab", 3), page(4, "cd", null)], plan),
  );
  assert(!completePlanDelivered([page(0, "wrong", null)], plan));
});
test("a current generation's plan_read call or report is not delivered-plan authority", () => {
  const request = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          { id: "page", function: { name: "plan_read", arguments: "{}" } },
          {
            id: "approve",
            function: {
              name: "report",
              arguments: JSON.stringify({ kind: "APPROVE" }),
            },
          },
        ],
      },
    ],
  };
  assert(!completePlanDelivered([request], "Complete plan"));
});
