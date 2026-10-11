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
    "approval",
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
      "approval",
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
