import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSessions } from "./metrics.mjs";

test("native scorecard counts repeated observations across sessions without content", () => {
  const observation = (id, args, failed = false) => [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id, name: "read_document", arguments: args },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "read_document",
        content: [{ type: "text", text: "private sentinel" }],
        isError: failed,
      },
    },
  ];
  const result = summarizeSessions([
    { entries: observation("a", { id: "plan", offset: 0 }) },
    {
      entries: [
        ...observation("a", { offset: 0, id: "plan" }),
        ...observation("b", { id: "plan", offset: 5 }),
        ...observation("c", {}, true),
      ],
    },
  ]);
  assert.equal(result.tools.read_document, 4);
  assert.equal(result.failedTools, 1);
  assert.equal(result.uniqueReads, 2);
  assert.equal(result.repeatedReads, 1);
  assert.equal(result.repeatedDocumentReads, 1);
  assert(!JSON.stringify(result).includes("private sentinel"));
  assert(!JSON.stringify(result).includes("plan"));
});

test("only numeric maintained-context evidence leaves native entries", () => {
  const result = summarizeSessions([
    {
      entries: [
        {
          type: "compaction",
          summary: "private sentinel",
          details: {
            contextMaintenance: {
              beforeTokens: 12000,
              afterTokens: 3000,
              projectedTokens: 8000,
              projectedBytes: 40000,
              summaryCharacters: 2000,
              retainedMessages: 0,
              secret: "private sentinel",
            },
          },
        },
        {
          type: "compaction",
          details: {
            contextMaintenance: {
              projectedBytes: "private sentinel",
              afterTokens: -1,
            },
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "private sentinel",
            toolCallId: "x",
            content: [],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(result.compactions, [
    {
      beforeTokens: 12000,
      afterTokens: 3000,
      projectedTokens: 8000,
      projectedBytes: 40000,
      summaryCharacters: 2000,
      retainedMessages: 0,
    },
    {},
  ]);
  assert.equal(result.tools.unknown, 1);
  assert(!JSON.stringify(result).includes("private sentinel"));
});
