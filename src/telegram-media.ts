import { InputFile, type Api } from "grammy";
import type { Database } from "./db.js";
import type { MediaOutbox } from "./media-outbox.js";
import { errorFields, opsLog } from "./ops-log.js";
import {
  TelegramSendWithheld,
  withTelegramSendGuard,
} from "./telegram-topics.js";

/**
 * Sends the pictures queued for a run (and the agent runs it started) to the
 * owner, after that run's text reply, in the same thread. Used for direct
 * replies and for background work replies alike. Each picture is sent on its
 * own: one failure is logged and the rest still go. If delivery is withheld
 * part-way, the rest are dropped rather than sent late.
 */
export async function sendRunMedia(
  api: Api,
  db: Database,
  media: MediaOutbox | undefined,
  user: string,
  run: string,
  extra: { message_thread_id?: number },
  guard?: () => Promise<boolean>,
) {
  // A withheld reply leaves its pictures queued, to expire unsent.
  if (!media || (guard && !(await guard()))) return 0;
  let items;
  try {
    items = await media.takeForRun(db, user, run);
  } catch (error) {
    opsLog("telegram.media_failed", "warn", errorFields(error));
    return 0;
  }
  let sent = 0;
  for (const item of items) {
    if (guard && !(await guard())) break;
    try {
      await withTelegramSendGuard(guard, () => {
        const file = new InputFile(item.bytes, item.filename);
        const options = { ...extra, caption: item.caption };
        return item.kind === "animation"
          ? api.sendAnimation(user, file, options).then(() => {})
          : api.sendPhoto(user, file, options).then(() => {});
      });
      sent++;
    } catch (error) {
      if (error instanceof TelegramSendWithheld) break;
      opsLog("telegram.media_failed", "warn", errorFields(error));
    }
  }
  return sent;
}
