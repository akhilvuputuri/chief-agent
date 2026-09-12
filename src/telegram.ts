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
  const views = new TelegramViews(db, bot.api);
  const voice = new Voice(c);
  const queue = new SerialQueue();
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
    await queue.run(user, async () => {
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
    // Cancellation must bypass both conversation queues to interrupt an in-flight model request.
    if (ctx.message.text === "/workcancel") {
      await ensureUser(db, user);
      const claimed = await db.query(
        "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [ctx.update.update_id, user],
      );
      if (!claimed.rows.length) return;
      await assistant.cancel(user);
      await ctx.reply("Cancelled. Completed external actions remain recorded.");
      await db.query(
        "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
        [ctx.update.update_id],
      );
      return;
    }
    const command = ctx.message.text;
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
    await queue.run(user, async () => {
      await ensureUser(db, user);
      const claimed = await db.query(
        "INSERT INTO inbound_updates(update_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id",
        [ctx.update.update_id, user],
      );
      if (!claimed.rows.length) return;
      try {
        let message = ctx.message.text ?? "";
        const decision = /^\/(approve|deny) ([0-9a-f-]{36})$/i.exec(message);
        if (decision) {
          const result = await assistant.tools.decide(
            user,
            decision[2]!,
            decision[1] === "approve",
          );
          if (result.status === "approved")
            await db.query(
              "UPDATE work_tasks SET status='queued',pause_reason=NULL,next_run=now() WHERE user_id=$1 AND status='paused' AND pause_reason='awaiting_approval' AND used_ms<budget_ms AND used_models<budget_models AND used_tools<budget_tools",
              [user],
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
        } else if (message === "/continue") {
          const result = await assistant.grant(user);
          await ctx.reply(
            result.rows.length
              ? "Another execution budget allocation is queued. Completed steps are preserved."
              : "No paused task can be continued. An uncertain write requires inspection first.",
          );
        } else if (message === "/start") {
          await ctx.reply(
            `Tell me what you want to work on. I can research, manage tasks and notes, set reminders, compare roles, and remember preferences you ask me to keep. Browse /roles, /items, /schedules, /drafts or /briefing without a model call. Use /status for tracked steps, evidence and costs. Use /continue for paused tracked work or /workcancel to cancel it. Web search is ${c.TAVILY_API_KEY || c.OPENROUTER_API_KEY ? "available" : "not configured yet"}. Voice notes are ${voice.transcriptionReady ? "available" : "not configured yet"}. /voice explains audio replies. You can also send photos and PDF documents for me to read. Deleting a role requires your approval. I cannot send applications or emails.`,
          );
        } else if (message === "/reset") {
          await db.query("DELETE FROM conversations WHERE user_id=$1", [user]);
          await ctx.reply(
            "Conversation reset. Saved roles and preferences are still available.",
          );
        } else if (message === "/voice") {
          await ctx.reply(
            `Voice transcription is ${voice.transcriptionReady ? `configured with ${c.STT_PROVIDER}` : "not configured yet"}. Audio is held in memory, not saved. Transcripts become conversation history. AI-generated voice replies are ${c.VOICE_REPLIES === "true" && voice.synthesisReady ? "enabled" : "disabled"} by the server setting.`,
          );
        } else {
          let images: ImageAttachment[] | undefined;
          const file = classifyInbound(ctx.message);
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
            await ctx.reply(
              `I can read photos, image files (JPEG, PNG, WebP, GIF) and PDF documents, not ${file.mimeType || "this file type"}. Send the content as a PDF or a photo of it.`,
            );
            await db.query(
              "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
              [ctx.update.update_id],
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
            });
          } else if (file?.kind === "pdf") {
            if (file.bytes > limits.pdfBytes)
              throw new Error("Attachment too large");
            const bytes = await download(file.fileId, limits.pdfBytes);
            const extracted = await extractPdfText(bytes);
            if (!hasText(extracted)) {
              await ctx.reply(
                `${file.name} (${extracted.pages} pages) has no selectable text, so it is probably scanned. Send the pages as photos and I will read them as images.`,
              );
              await event(db, user, randomUUID(), "document.unreadable", {
                bytes: bytes.length,
                pages: extracted.pages,
              });
              await db.query(
                "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
                [ctx.update.update_id],
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
              await ctx.reply(
                "Voice transcription is not configured yet. Please send text for now.",
              );
              await db.query(
                "UPDATE inbound_updates SET status='completed' WHERE update_id=$1",
                [ctx.update.update_id],
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
          if (!message) {
            await ctx.reply(
              "Please send text, a voice note, a photo or a PDF document.",
            );
          } else {
            await ctx.replyWithChatAction("typing");
            const reply = await assistant.respondDetailed(
              user,
              message,
              (text, runId) =>
                views.deliver(
                  user,
                  String(ctx.chat.id),
                  { reply: text, runId },
                  "progress",
                ),
              images,
            );
            await sendCalendarApprovals(bot, db, user);
            await views.deliver(user, String(ctx.chat.id), reply);
            const formatted = formatTelegram(reply.reply);
            if (ctx.message.voice && c.VOICE_REPLIES === "true") {
              try {
                const audio = await voice.speak(
                  formatted.map((part) => part.text).join(""),
                );
                await ctx.replyWithVoice(
                  new InputFile(audio.bytes, audio.filename),
                  { caption: "AI-generated voice" },
                );
              } catch {
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
        await db.query(
          "UPDATE inbound_updates SET status='failed' WHERE update_id=$1",
          [ctx.update.update_id],
        );
        await ctx.reply(
          `I could not finish that request. A tool may already have saved changes; ask me to list your roles before retrying. Voice notes must be under 3 minutes and 10 MB; images under ${describeBytes(limits.imageBytes)} and PDFs under ${describeBytes(limits.pdfBytes)}.`,
        );
      }
    });
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
) {
  const rows = (
    await db.query(
      "SELECT id,payload FROM approvals WHERE user_id=$1 AND operation='calendar_create' AND status='pending' AND expires_at>now() AND NOT (payload ? 'telegramMessageId') ORDER BY created_at",
      [user],
    )
  ).rows;
  for (const row of rows) {
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
