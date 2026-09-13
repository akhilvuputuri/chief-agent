import { WorkTools, renderWork, renderWorkList } from "./work.js";
import { TelegramViews, viewCallback } from "./telegram-views.js";
import type { Collection, View } from "./telegram-view-render.js";
import { formatTelegram } from "./telegram-format.js";
import { calendarPreview, validateDraft } from "./calendar-draft.js";
import { Bot, InputFile } from "grammy";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Assistant } from "./agent.js";
import type { Database } from "./db.js";
import { ensureUser, event } from "./db.js";
import { allowedChat, SerialQueue } from "./security.js";
import { Voice, boundedBytes } from "./providers.js";
import {
  classifyInbound,
  describeBytes,
  documentMessage,
  extractPdfText,
  hasText,
  imageMessage,
  limits,
  toImageAttachment,
  validFilePath,
} from "./attachments.js";
import type { ImageAttachment } from "./protocol.js";
export function telegram(c: Config, assistant: Assistant, db: Database) {
  const bot = new Bot(c.TELEGRAM_BOT_TOKEN);
  const views = new TelegramViews(db, bot.api, undefined, c.MINIAPP_ORIGIN);
  const voice = new Voice(c);
  const controls = new SerialQueue();
  const preparation = new PreparationQueue(2);
  const ids = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
  bot.callbackQuery(viewCallback, async (ctx) => {
    if (!allowedChat(ctx.from.id, ctx.chat?.type ?? "", ids)) return;
    // Clear Telegram's spinner before loading data; do not queue behind a long agent turn.
    await ctx.answerCallbackQuery();
    const message = ctx.callbackQuery.message;
    if (!message) return;
    const notice = await views.navigate(
      String(ctx.from.id),
      String(message.chat.id),
      message.message_id,
      ctx.callbackQuery.data,
    );
    if (notice) await ctx.reply(notice);
  });
  bot.callbackQuery(/^cal:(yes|no):([0-9a-f-]{36})$/, async (ctx) => {
    if (!allowedChat(ctx.from.id, ctx.chat?.type ?? "", ids)) return;
    const user = String(ctx.from.id);
    await ctx.answerCallbackQuery();
    await controls.run(user, async () => {
      try {
        const result = await assistant.tools.decideCalendar(
          user,
          ctx.match[2]!,
          ctx.match[1] === "yes",
        );
        const text =
          result.status === "created"
            ? `Calendar event created.${result.url ? "\n" + result.url : ""}`
            : result.status === "denied"
              ? "Draft declined. No event was created."
              : "The event's outcome is uncertain. I will not create it again. Click Check status to look for the existing event.";
        await ctx.reply(text, {
          reply_markup: {
            inline_keyboard:
              result.status === "uncertain"
                ? [
                    [
                      {
                        text: "Check status",
                        callback_data: `cal:yes:${ctx.match[2]}`,
                      },
                    ],
                  ]
                : [],
          },
        });
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
        if (result.status === "created" || result.status === "denied")
          await db.query(
            "UPDATE work_tasks SET status='queued',pause_reason=NULL,next_run=now() WHERE user_id=$1 AND id IN (SELECT w.task_id FROM work_turns w JOIN approvals a ON a.run_id=w.run_id AND a.user_id=w.user_id WHERE a.id=$2 AND a.user_id=$1) AND status='paused' AND pause_reason='awaiting_approval' AND used_ms<budget_ms AND used_models<budget_models AND used_tools<budget_tools",
            [user, ctx.match[2]],
          );
      } catch {
        await ctx.reply(
          "This calendar approval is unavailable, expired, or could not be checked. No new creation request will be retried automatically.",
        );
      }
    });
  });
  bot.on("message", async (ctx) => {
    if (!allowedChat(ctx.from?.id, ctx.chat.type, ids)) return;
    const user = String(ctx.from.id);
    // Controls never wait behind reasoning, transcription, or speech delivery.
    const control =
      /^\/(status|continue|cancel|workcancel)(?: ([0-9a-f-]{36}))?$/i.exec(
        ctx.message.text ?? "",
      );
    if (control) {
      await ensureUser(db, user);
      const claimed = await db.query(
        "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [ctx.update.update_id, user],
      );
      if (!claimed.rows.length) return;
      try {
        const id = control[2];
        const name = control[1]!.toLowerCase();
        let text: string;
        if (name === "status") {
          const work = new WorkTools(db);
          text = id
            ? renderWork(await work.snapshot(user, id))
            : renderWorkList(await work.list(user));
        } else if (name === "continue") {
          const result = await assistant.grant(user, id);
          text = result.rows.length
            ? "Another execution allocation is queued for the selected task. Completed steps are preserved."
            : "Choose a paused task with /status, then use /continue followed by its ID. Uncertain writes need inspection.";
        } else {
          const result = await assistant.cancel(user, id);
          text = result.cancelled
            ? "Cancelled the selected work. Completed external actions remain recorded."
            : "No matching active work. Use /status to choose a background task, then /cancel followed by its ID.";
        }
        for (const part of formatTelegram(text))
          await ctx.reply(part.text, { entities: part.entities });
        await db.query(
          "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
      } catch {
        await db.query(
          "UPDATE inbound_updates SET status='failed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
        await ctx.reply(
          "Could not apply that task control. Use /status to inspect the saved state.",
        );
      }
      return;
    }
    const command = ctx.message.text;
    if (command === "/canvases" || command === "/app") {
      await ensureUser(db, user);
      const claimed = await db.query(
        "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [ctx.update.update_id, user],
      );
      if (!claimed.rows.length) return;
      try {
        await ctx.reply(
          c.MINIAPP_ORIGIN
            ? "Open your saved canvases and roles."
            : "The Mini App is not configured yet.",
          c.MINIAPP_ORIGIN
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Open Companion",
                        web_app: { url: c.MINIAPP_ORIGIN + "/miniapp/" },
                      },
                    ],
                  ],
                },
              }
            : {},
        );
        await db.query(
          "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
      } catch {
        await db.query(
          "UPDATE inbound_updates SET status='failed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
      }
      return;
    }
    if (
      command &&
      [
        "/status",
        "/roles",
        "/items",
        "/schedules",
        "/drafts",
        "/briefing",
      ].includes(command)
    ) {
      await ensureUser(db, user);
      const claimed = await db.query(
        "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [ctx.update.update_id, user],
      );
      if (!claimed.rows.length) return;
      try {
        const view: View =
          command === "/status"
            ? { kind: "task" }
            : command === "/briefing"
              ? { kind: "briefing" }
              : { kind: "records", collection: command.slice(1) as Collection };
        await views.open(user, String(ctx.chat.id), view);
        await db.query(
          "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
      } catch {
        await db.query(
          "UPDATE inbound_updates SET status='failed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
        await ctx.reply("Could not open that view. Try again shortly.");
      }
      return;
    }
    const decision = /^\/(approve|deny) ([0-9a-f-]{36})$/i.exec(command ?? "");
    if (decision || ["/start", "/reset", "/voice"].includes(command ?? "")) {
      await ensureUser(db, user);
      const claimed = await db.query(
        "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [ctx.update.update_id, user],
      );
      if (!claimed.rows.length) return;
      const applyCommand = async () => {
        try {
          if (decision) {
            const result = await assistant.tools.decide(
              user,
              decision[2]!,
              decision[1]!.toLowerCase() === "approve",
            );
            if (result.status === "approved")
              await db.query(
                "UPDATE work_tasks SET status='queued',pause_reason=NULL,next_run=now() WHERE user_id=$1 AND id IN (SELECT w.task_id FROM work_turns w JOIN approvals a ON a.run_id=w.run_id AND a.user_id=w.user_id WHERE a.id=$2 AND a.user_id=$1) AND status='paused' AND pause_reason='awaiting_approval' AND used_ms<budget_ms AND used_models<budget_models AND used_tools<budget_tools",
                [user, decision[2]],
              );
            await event(db, user, randomUUID(), "approval.decided", {
              id: decision[2],
              status: result.status,
            });
            await ctx.reply(
              result.status === "approved"
                ? result.operation === "skill_activate"
                  ? "Approved. The selected skill version is now active. Previous versions remain available for rollback."
                  : "Approved. The saved role was deleted."
                : "Denied. The role was kept.",
            );
          } else if (command === "/start") {
            await ctx.reply(
              `Tell me what you want to work on. I can research, manage tasks and notes, set reminders, compare roles, and remember preferences you ask me to keep. Browse /roles, /items, /schedules, /drafts or /briefing without a model call. Use /status for tracked steps, evidence and costs. Use /continue for paused tracked work or /workcancel to cancel it. Web search is ${c.TAVILY_API_KEY || c.OPENROUTER_API_KEY ? "available" : "not configured yet"}. Voice notes are ${voice.transcriptionReady ? "available" : "not configured yet"}. /voice explains audio replies. You can also send photos and PDF documents for me to read. Deleting a role requires your approval. I cannot send applications or emails.`,
            );
          } else if (command === "/reset") {
            await assistant.resetConversation(user);
            await ctx.reply(
              "Conversation reset. Saved roles and preferences are still available.",
            );
          } else {
            await ctx.reply(
              `Voice transcription is ${voice.transcriptionReady ? `configured with ${c.STT_PROVIDER}` : "not configured yet"}. Audio is held in memory, not saved. Transcripts become conversation history. AI-generated voice replies are ${c.VOICE_REPLIES === "true" && voice.synthesisReady ? "enabled" : "disabled"} by the server setting.`,
            );
          }
          await db.query(
            "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
            [ctx.update.update_id],
          );
        } catch {
          await db.query(
            "UPDATE inbound_updates SET status='failed' WHERE update_id=$1",
            [ctx.update.update_id],
          );
          await ctx.reply(
            "Could not apply that command. Use /status to inspect the saved state.",
          );
        }
      };
      // Reset waits for the Assistant's earlier commits; other controls stay live.
      if (command === "/reset") await applyCommand();
      else await controls.run(user, applyCommand);
      return;
    }
    await ensureUser(db, user);
    const claimed = await db.query(
      "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
      [ctx.update.update_id, user],
    );
    if (!claimed.rows.length) return;
    const file = classifyInbound(ctx.message);
    const needsPreparation = !!(file || ctx.message.voice || !ctx.message.text);
    const inputId = await assistant.recordInput(
      user,
      ctx.message.text ??
        ctx.message.caption ??
        "[attachment awaiting extraction]",
      {
        updateId: ctx.update.update_id,
        messageId: ctx.message.message_id,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
        receivedAt: new Date().toISOString(),
        preparing: needsPreparation,
        voiceReply: !!ctx.message.voice,
      },
    );
    await event(db, user, inputId, "telegram.input_received", {
      inputId,
      updateId: ctx.update.update_id,
      messageId: ctx.message.message_id,
      replyToMessageId: ctx.message.reply_to_message?.message_id ?? null,
    });
    let deliveryGuard: (() => Promise<boolean>) | undefined;
    let deliveryRun: string | undefined;
    try {
      const prepare = async () => {
        let message = ctx.message.text ?? "";
        let images: ImageAttachment[] | undefined;
        const reject = async (notice: string) => {
          // A terminal input unblocks later ready messages in the ordered inbox.
          await assistant.failInput(user, inputId);
          await ctx.reply(notice);
        };
        const download = async (fileId: string, max: number) => {
          const meta = await ctx.api.getFile(fileId);
          if (!validFilePath(meta.file_path))
            throw new Error("Unexpected file path");
          return boundedBytes(
            await fetch(
              `https://api.telegram.org/file/bot${c.TELEGRAM_BOT_TOKEN}/${meta.file_path}`,
              { signal: AbortSignal.timeout(30000) },
            ),
            max,
          );
        };
        if (file?.kind === "unsupported") {
          await reject(
            `I can read photos, image files (JPEG, PNG, WebP, GIF) and PDF documents, not ${file.mimeType || "this file type"}. Send the content as a PDF or a photo of it.`,
          );
          return;
        }
        if (file?.kind === "image") {
          if (file.bytes > limits.imageBytes)
            throw new Error("Attachment too large");
          const image = toImageAttachment(
            file,
            await download(file.fileId, limits.imageBytes),
          );
          images = [image];
          message = imageMessage(ctx.message.caption ?? "", images);
          await event(db, user, randomUUID(), "image.received", {
            bytes: image.bytes,
            mimeType: image.mimeType,
            attachmentId: image.id,
            sha256: image.sha256,
          });
        } else if (file?.kind === "pdf") {
          if (file.bytes > limits.pdfBytes)
            throw new Error("Attachment too large");
          const bytes = await download(file.fileId, limits.pdfBytes);
          const extracted = await extractPdfText(bytes);
          if (!hasText(extracted)) {
            await event(db, user, randomUUID(), "document.unreadable", {
              bytes: bytes.length,
              pages: extracted.pages,
            });
            await reject(
              `${file.name} (${extracted.pages} pages) has no selectable text, so it is probably scanned. Send the pages as photos and I will read them as images.`,
            );
            return;
          }
          const sourceId = randomUUID();
          await db.query(
            "INSERT INTO research_sources(id,user_id,url,content) VALUES($1,$2,$3,$4)",
            [
              sourceId,
              user,
              `telegram:document/${ctx.message.document?.file_unique_id ?? ctx.update.update_id}/${encodeURIComponent(file.name)}`,
              extracted.text,
            ],
          );
          message = documentMessage(
            ctx.message.caption ?? "",
            { name: file.name, bytes: bytes.length },
            extracted,
            sourceId,
          );
          await event(db, user, randomUUID(), "document.extracted", {
            bytes: bytes.length,
            pages: extracted.pages,
            extractedPages: extracted.extractedPages,
            characters: extracted.text.length,
            truncated: extracted.truncated,
          });
        }
        if (ctx.message.voice) {
          if (!voice.transcriptionReady) {
            await reject(
              "Voice transcription is not configured yet. Please send text for now.",
            );
            return;
          }
          if (
            ctx.message.voice.duration > 180 ||
            (ctx.message.voice.file_size ?? 0) > 10 * 1024 * 1024
          )
            throw new Error("Voice note too long");
          const audio = await download(
            ctx.message.voice.file_id,
            10 * 1024 * 1024,
          );
          message = await voice.transcribe(audio);
          await event(db, user, randomUUID(), "voice.transcribed", {
            bytes: audio.length,
          });
        }
        if (!message.trim()) {
          await reject(
            "Please send text, a voice note, a photo or a PDF document.",
          );
          return;
        }
        await assistant.prepareInput(user, inputId, message, images);
        await event(db, user, inputId, "telegram.input_ready", {
          inputId,
          characters: message.length,
        });
        return { message, images };
      };
      // Only bounded attachment work occupies a preparation slot. The Assistant
      // owns response serialization and may absorb this input into an active run.
      const prepared = needsPreparation
        ? await preparation.run(user, prepare)
        : await prepare();
      if (prepared) {
        await ctx.replyWithChatAction("typing");
        const reply = await assistant.respondDetailed(
          user,
          prepared.message,
          async (text, runId) => {
            const guard = () =>
              runId
                ? assistant.isCurrentRun(user, runId)
                : Promise.resolve(false);
            if (await guard())
              await views.deliver(
                user,
                String(ctx.chat.id),
                { reply: text, runId },
                "progress",
                guard,
              );
          },
          prepared.images,
          { id: inputId },
        );
        deliveryGuard = () => assistant.isCurrentDelivery(user, reply);
        if (reply.reply || reply.notices?.length) deliveryRun = reply.runId;
        if ((reply.reply || reply.notices?.length) && (await deliveryGuard())) {
          await sendCalendarApprovals(bot, db, user, deliveryGuard);
          if (reply.reply)
            await views.deliver(
              user,
              String(ctx.chat.id),
              reply,
              "answer",
              deliveryGuard,
            );
          if (
            reply.reply &&
            reply.voiceReply &&
            c.VOICE_REPLIES === "true" &&
            (await deliveryGuard())
          ) {
            try {
              const audio = await voice.speak(
                formatTelegram(reply.reply)
                  .map((part) => part.text)
                  .join(""),
              );
              // New input can arrive during TTS even after the text was sent.
              if (await deliveryGuard())
                await ctx.replyWithVoice(
                  new InputFile(audio.bytes, audio.filename),
                  { caption: "AI-generated voice" },
                );
            } catch {
              if (await deliveryGuard())
                await ctx.reply(
                  "The text reply is ready; audio generation is unavailable.",
                );
            }
          }
        }
      }
      await db.query(
        "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
        [ctx.update.update_id],
      );
    } catch {
      await assistant.failInput(user, inputId);
      await db.query(
        "UPDATE inbound_updates SET status='failed' WHERE update_id=$1",
        [ctx.update.update_id],
      );
      if (!deliveryGuard || (await deliveryGuard()))
        await ctx.reply(
          `I could not finish that request. A tool may already have saved changes; ask me to list your roles before retrying. Voice notes must be under 3 minutes and 10 MB; images under ${describeBytes(limits.imageBytes)} and PDFs under ${describeBytes(limits.pdfBytes)}.`,
        );
    } finally {
      if (deliveryRun) await assistant.finishDelivery?.(user, deliveryRun);
    }
  });
  bot.catch(() =>
    console.error(JSON.stringify({ event: "telegram.handler_failed" })),
  );
  return bot;
}

export async function sendCalendarApprovals(
  bot: Bot,
  db: Database,
  user: string,
  guard?: () => Promise<boolean>,
) {
  if (guard && !(await guard())) return;
  const rows = (
    await db.query(
      "SELECT id,payload FROM approvals WHERE user_id=$1 AND operation='calendar_create' AND status='pending' AND expires_at>now() AND NOT (payload ? 'telegramMessageId') ORDER BY created_at",
      [user],
    )
  ).rows;
  for (const row of rows) {
    if (guard && !(await guard())) return;
    const message = await bot.api.sendMessage(
      user,
      calendarPreview(validateDraft(row.payload.draft)),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Approve event", callback_data: `cal:yes:${row.id}` },
              { text: "Decline", callback_data: `cal:no:${row.id}` },
            ],
          ],
        },
      },
    );
    await db.query(
      "UPDATE approvals SET payload=jsonb_set(payload,'{telegramMessageId}',$3::jsonb) WHERE id=$1 AND user_id=$2",
      [row.id, user, JSON.stringify(message.message_id)],
    );
  }
}

/** Limit expensive download/extraction work without holding the response queue. */
class PreparationQueue {
  private users = new Map<
    string,
    { active: number; waiting: (() => void)[] }
  >();
  constructor(private concurrency: number) {}
  async run<T>(user: string, prepare: () => Promise<T>): Promise<T> {
    const state = this.users.get(user) ?? { active: 0, waiting: [] };
    this.users.set(user, state);
    await new Promise<void>((resolve) => {
      const start = () => {
        state.active++;
        resolve();
      };
      if (state.active < this.concurrency) start();
      else state.waiting.push(start);
    });
    try {
      return await prepare();
    } finally {
      state.active--;
      state.waiting.shift()?.();
      if (!state.active) this.users.delete(user);
    }
  }
}
