import { formatTelegram, type FormattedMessage } from "../telegram-format.js";
import type { InlineKeyboardMarkup } from "grammy/types";
import { StatusMessageGone } from "./notices.js";
/** Which owner decision a delivered message's buttons answer. */
export type CodingApproval =
  | { kind: "requirements" | "merge"; id: string }
  /** A coding job's question with up to three answers (journal 192). */
  | { kind: "ask"; id: string; options: string[] };
type Receipt = { message_id: number };
/**
 * Sends a coding message; the buttons go on its last part, whose receipt binds the decision.
 * `plain` is owner or worker text shown as written after the formatted text, never parsed
 * as markup (the Start card's goal).
 */
export async function sendCodingDelivery(
  text: string,
  approval: CodingApproval | undefined,
  transport: {
    text: (
      part: FormattedMessage,
      keyboard?: InlineKeyboardMarkup,
    ) => Promise<Receipt>;
  },
  plain?: string,
): Promise<Receipt> {
  const keyboard =
    approval?.kind === "requirements"
      ? {
          inline_keyboard: [
            [
              {
                text: "Start",
                callback_data: `cod:yes:${approval.id}`,
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
        : approval?.kind === "ask"
          ? {
              inline_keyboard: approval.options.map((option, index) => [
                { text: option, callback_data: `cdq:${index}:${approval.id}` },
              ]),
            }
          : undefined;
  const parts = formatTelegram(text);
  if (plain) {
    const end = parts.at(-1)!;
    const joined = `${end.text}\n\n${plain}`;
    if (joined.length > 4096)
      throw new Error("Coding message exceeds its presentation bound");
    parts[parts.length - 1] = { text: joined, entities: end.entities };
  }
  let last: Receipt | undefined;
  for (const [index, part] of parts.entries())
    last = await transport.text(
      part,
      index === parts.length - 1 ? keyboard : undefined,
    );
  if (!last) throw new Error("Coding delivery has no message");
  return last;
}
/**
 * Edits the owner's coding status message in place. An unchanged text is already shown; a
 * message that is gone or no longer editable is reported as StatusMessageGone (Telegram
 * refused it, so nothing changed), and the controller starts a new status message.
 */
export async function editCodingStatus(
  text: string,
  edit: (part: FormattedMessage) => Promise<unknown>,
): Promise<void> {
  const parts = formatTelegram(text);
  if (parts.length !== 1)
    throw new Error("Coding status exceeds its presentation bound");
  try {
    await edit(parts[0]!);
  } catch (error) {
    const description = String(
      (error as { description?: unknown })?.description ??
        (error as Error)?.message ??
        "",
    );
    if (/message is not modified/i.test(description)) return;
    if (
      /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(
        description,
      )
    )
      throw new StatusMessageGone();
    throw error;
  }
}
