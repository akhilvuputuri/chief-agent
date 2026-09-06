import { formatTelegram } from "./telegram-format.js";
import { Bot, InputFile } from "grammy";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Assistant } from "./agent.js";
import type { Database } from "./db.js";
import { ensureUser, event } from "./db.js";
import { allowedChat, SerialQueue } from "./security.js";
import { Voice, boundedBytes } from "./providers.js";
export function telegram(c: Config, assistant: Assistant, db: Database) {
  const bot = new Bot(c.TELEGRAM_BOT_TOKEN);
  const voice = new Voice(c);
  const queue = new SerialQueue();
  const ids = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
  bot.on("message", async (ctx) => {
    if (!allowedChat(ctx.from?.id, ctx.chat.type, ids)) return;
    const user = String(ctx.from.id);
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
          const result = await db.query(
            `UPDATE work_tasks SET status='queued',passes=0,next_run=now(),updated_at=now() WHERE user_id=$1 AND status IN ('active','paused') RETURNING id`,
            [user],
          );
          await ctx.reply(
            result.rows.length
              ? "Queued up to three continuation passes. I will report recorded progress."
              : "No paused task to continue.",
          );
        } else if (message === "/workcancel") {
          await db.query(
            `UPDATE work_tasks SET status='cancelled',lease=NULL WHERE user_id=$1 AND status NOT IN ('done','cancelled')`,
            [user],
          );
          await ctx.reply(
            "Current tracked work cancelled. Completed external actions are retained.",
          );
        } else if (message === "/start") {
          await ctx.reply(
            `Tell me what you want to work on. I can research, manage tasks and notes, set reminders, compare roles, and remember preferences you ask me to keep. Use /continue for paused tracked work or /workcancel to cancel it. Web search is ${c.TAVILY_API_KEY || c.OPENROUTER_API_KEY ? "available" : "not configured yet"}. Voice notes are ${voice.transcriptionReady ? "available" : "not configured yet"}. /voice explains audio replies. Deleting a role requires your approval. I cannot send applications or emails.`,
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
            const file = await ctx.getFile();
            if (
              !file.file_path ||
              !/^voice\/[a-zA-Z0-9_.-]+$/.test(file.file_path)
            )
              throw new Error("Unexpected file path");
            const audio = await boundedBytes(
              await fetch(
                `https://api.telegram.org/file/bot${c.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
                { signal: AbortSignal.timeout(30000) },
              ),
              10 * 1024 * 1024,
            );
            message = await voice.transcribe(audio);
            await event(db, user, randomUUID(), "voice.transcribed", {
              bytes: audio.length,
            });
          }
          if (!message) {
            await ctx.reply("Please send text or a voice note.");
          } else {
            await ctx.replyWithChatAction("typing");
            const reply = await assistant.respond(user, message);
            const formatted = formatTelegram(reply);
            for (const part of formatted)
              await ctx.reply(part.text, {
                entities: part.entities,
                link_preview_options: { is_disabled: true },
              });
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
          "I could not finish that request. A tool may already have saved changes; ask me to list your roles before retrying. Voice notes must be under 3 minutes and 10 MB.",
        );
      }
    });
  });
  bot.catch(() =>
    console.error(JSON.stringify({ event: "telegram.handler_failed" })),
  );
  return bot;
}
