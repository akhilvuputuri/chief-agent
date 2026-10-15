import { test } from "node:test";
import assert from "node:assert/strict";
import { sendCodingDelivery } from "../src/coding/delivery.js";

test("complete Unicode requirements and approval buttons share one document receipt", async () => {
  const document = {
    filename: "coding-plan-r2.md",
    content: "# Original request\n" + "完整要求😀\n".repeat(6000),
  };
  let sent = 0;
  const receipt = await sendCodingDelivery(
    "**Coding plan — revision 2**\nReview the attached complete requirements.",
    { kind: "requirements", id: "approval" },
    document,
    {
      text: async () => {
        throw Error("Must not split approval into text fragments");
      },
      document: async (file, caption, keyboard) => {
        sent++;
        assert.equal(file.content, document.content);
        assert(caption.text.length <= 1024);
        assert.equal(
          keyboard?.inline_keyboard[0]?.[0]?.callback_data,
          "cod:yes:approval",
        );
        return { message_id: 91 };
      },
    },
  );
  assert.equal(sent, 1);
  assert.equal(receipt.message_id, 91);
});
test("failed document delivery cannot be reported as an approval receipt", async () => {
  await assert.rejects(
    sendCodingDelivery(
      "Review attached requirements",
      { kind: "requirements", id: "approval" },
      { filename: "plan.md", content: "Complete requirements" },
      {
        text: async () => ({ message_id: 1 }),
        document: async () => {
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
    undefined,
    {
      text: async (_part, keyboard) => {
        keyboards.push(keyboard);
        return { message_id: 7 };
      },
      document: async () => {
        throw Error("Merge cards are text messages");
      },
    },
  );
  assert.equal(receipt.message_id, 7);
  assert.deepEqual(
    keyboards.at(-1)?.inline_keyboard[0]?.map((b: any) => b.callback_data),
    ["cdm:yes:card", "cdm:no:card"],
  );
});
