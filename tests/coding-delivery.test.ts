import { test } from "node:test";
import assert from "node:assert/strict";
import { sendCodingDelivery } from "../src/coding/delivery.js";

test("a Start card is one text message with a single Start button", async () => {
  const keyboards: any[] = [];
  const receipt = await sendCodingDelivery(
    "**Ready to start**\n\nFix the reminder bug 😀\n\nCoder: anthropic/claude-sonnet-5.5. Reviewer: anthropic/claude-opus-5.5.",
    { kind: "requirements", id: "approval" },
    {
      text: async (_part, keyboard) => {
        keyboards.push(keyboard);
        return { message_id: 91 };
      },
    },
  );
  assert.equal(receipt.message_id, 91);
  assert.equal(keyboards.length, 1);
  assert.deepEqual(
    keyboards[0]?.inline_keyboard.map((row: any[]) =>
      row.map((b) => [b.text, b.callback_data]),
    ),
    [[["Start", "cod:yes:approval"]]],
  );
});
test("a failed Start card send cannot be reported as an approval receipt", async () => {
  await assert.rejects(
    sendCodingDelivery(
      "**Ready to start**",
      { kind: "requirements", id: "approval" },
      {
        text: async () => {
          throw Error("Delivery uncertain");
        },
      },
    ),
    /uncertain/,
  );
});
test("merge cards carry merge and keep-open buttons on the final text part", async () => {
  const keyboards: any[] = [];
  const receipt = await sendCodingDelivery(
    "**Ready to merge**\nAll checks and reviews passed.",
    { kind: "merge", id: "card" },
    {
      text: async (_part, keyboard) => {
        keyboards.push(keyboard);
        return { message_id: 7 };
      },
    },
  );
  assert.equal(receipt.message_id, 7);
  assert.deepEqual(
    keyboards.at(-1)?.inline_keyboard[0]?.map((b: any) => b.callback_data),
    ["cdm:yes:card", "cdm:no:card"],
  );
});
