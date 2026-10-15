import { formatTelegram, type FormattedMessage } from "../telegram-format.js";
import type { InlineKeyboardMarkup } from "grammy/types";
export type CodingDocument = { filename: string; content: string };
/** Which owner decision a delivered message's buttons answer. */
export type CodingApproval = { kind: "requirements" | "merge"; id: string };
type Receipt = { message_id: number };
/** One document message binds the full brief and its approval buttons atomically. */
export async function sendCodingDelivery(
  text: string,
  approval: CodingApproval | undefined,
  document: CodingDocument | undefined,
  transport: {
    text: (
      part: FormattedMessage,
      keyboard?: InlineKeyboardMarkup,
    ) => Promise<Receipt>;
    document: (
      document: CodingDocument,
      caption: FormattedMessage,
      keyboard?: InlineKeyboardMarkup,
    ) => Promise<Receipt>;
  },
): Promise<Receipt> {
  const keyboard =
    approval?.kind === "requirements"
      ? {
          inline_keyboard: [
            [
              {
                text: "Approve requirements",
                callback_data: `cod:yes:${approval.id}`,
              },
              {
                text: "Request changes",
                callback_data: `cod:no:${approval.id}`,
              },
            ],
          ],
        }
      : approval?.kind === "merge"
        ? {
            inline_keyboard: [
              [
                { text: "Merge", callback_data: `cdm:yes:${approval.id}` },
                { text: "Keep open", callback_data: `cdm:no:${approval.id}` },
              ],
            ],
          }
        : undefined;
  if (document) {
    const captions = formatTelegram(text, 1024);
    if (captions.length !== 1)
      throw new Error("Coding document caption exceeds its presentation bound");
    if (
      Buffer.from(document.content, "utf8").toString("utf8") !==
      document.content
    )
      throw new Error("Coding document contains invalid Unicode");
    return transport.document(document, captions[0]!, keyboard);
  }
  const parts = formatTelegram(text);
  let last: Receipt | undefined;
  for (const [index, part] of parts.entries())
    last = await transport.text(
      part,
      index === parts.length - 1 ? keyboard : undefined,
    );
  if (!last) throw new Error("Coding delivery has no message");
  return last;
}
