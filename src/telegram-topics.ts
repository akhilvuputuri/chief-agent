// Topics in the bot's private chat (Telegram threaded mode). Chief owns a small fixed set
// of topics and posts scheduled output there; General stays the main conversation.
// Everything degrades to General: with threaded mode off, the switch off, or any failure
// to create a topic, sends simply leave out message_thread_id.
import { createHash } from "node:crypto";
import type { Api } from "grammy";
import type { Database } from "./db.js";
import { event } from "./db.js";
import { errorFields, opsLog } from "./ops-log.js";

export type TopicKey = "news" | "markets";
// icon_color must be one of Telegram's six topic colours.
const topics = {
  news: { name: "News", icon_color: 0x6fb9f0 },
  markets: { name: "Markets", icon_color: 0x8eee98 },
} as const satisfies Record<TopicKey, { name: string; icon_color: number }>;

/** Send options for a thread. General (id 1) is addressed by leaving the id out. */
export const inThread = (thread?: number) =>
  thread && thread > 1 ? { message_thread_id: thread } : {};

/** The thread of an inbound message, if it was typed in a topic. */
export const threadOf = (message?: {
  is_topic_message?: boolean;
  message_thread_id?: number;
}) =>
  message?.is_topic_message && (message.message_thread_id ?? 0) > 1
    ? message.message_thread_id
    : undefined;

const describe = (error: unknown) =>
  String(
    (error as { description?: string })?.description ??
      (error as Error)?.message,
  );
// The topic is gone: forget it and create it again.
const missing = (error: unknown) =>
  /thread not found|topic_deleted|topic not found|TOPIC_ID_INVALID/i.test(
    describe(error),
  );
// Any other rejection about the topic itself (for example a closed topic). A 400 means
// nothing was sent, so the message can go to General instead of being lost.
const unusable = (error: unknown) =>
  (error as { error_code?: number })?.error_code === 400 &&
  /topic|thread/i.test(describe(error));

type TopicApi = Pick<Api, "getMe" | "createForumTopic">;

// Thread ids live in the existing events table (no migration), one stable run id per
// owner and topic, so the lookup uses the run index. The newest row wins; a null
// threadId records that the topic was deleted in Telegram.
const ledger = (user: string, key: TopicKey) => {
  const h = createHash("sha256")
    .update(`telegram-topic:${user}:${key}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export class TelegramTopics {
  private ready?: Promise<boolean>;
  private creating = new Map<string, Promise<number | undefined>>();
  private recovering = new Map<string, Promise<number | undefined>>();
  constructor(
    private db: Database,
    private api: TopicApi,
    private enabled = true,
  ) {}

  /**
   * Whether the bot has threaded mode on. A successful answer is kept until restart, so
   * changing the BotFather switch takes effect on the next deploy; a failed check is
   * retried on the next send.
   */
  private available() {
    if (!this.enabled) return Promise.resolve(false);
    this.ready ??= this.api.getMe().then(
      (me) => !!me.has_topics_enabled,
      (error) => {
        this.ready = undefined;
        opsLog("telegram.topics_check_failed", "warn", errorFields(error));
        return false;
      },
    );
    return this.ready;
  }

  /** The topic's thread id, creating the topic once. Undefined means "send to General". */
  async thread(user: string, key: TopicKey): Promise<number | undefined> {
    if (!(await this.available())) return undefined;
    const saved = await this.stored(user, key);
    if (typeof saved === "number") return saved;
    const id = `${user}:${key}`;
    let pending = this.creating.get(id);
    if (!pending) {
      pending = this.create(user, key).finally(() => this.creating.delete(id));
      this.creating.set(id, pending);
    }
    return pending;
  }

  private async stored(user: string, key: TopicKey): Promise<unknown> {
    return (
      await this.db.query(
        "SELECT data->'threadId' AS thread FROM events WHERE run_id=$1 AND user_id=$2 AND type='telegram.topic' ORDER BY id DESC LIMIT 1",
        [ledger(user, key), user],
      )
    ).rows[0]?.thread;
  }

  private async create(user: string, key: TopicKey) {
    try {
      const topic = await this.api.createForumTopic(user, topics[key].name, {
        icon_color: topics[key].icon_color,
      });
      opsLog("telegram.topic_created", "info", { kind: key });
      // The topic exists now; use it for this send even if recording it fails.
      await event(this.db, user, ledger(user, key), "telegram.topic", {
        key,
        threadId: topic.message_thread_id,
      }).catch((error) =>
        opsLog("telegram.topic_record_failed", "warn", {
          kind: key,
          ...errorFields(error),
        }),
      );
      return topic.message_thread_id;
    } catch (error) {
      opsLog("telegram.topic_failed", "warn", {
        kind: key,
        ...errorFields(error),
      });
      return undefined;
    }
  }

  /** Forgets a deleted topic and creates it again. Concurrent recoveries share one. */
  private recover(user: string, key: TopicKey, stale: number) {
    const id = `${user}:${key}:${stale}`;
    let pending = this.recovering.get(id);
    if (!pending) {
      pending = (async () => {
        // Another send may already have replaced this topic.
        const current = await this.stored(user, key);
        if (typeof current === "number" && current !== stale) return current;
        await event(this.db, user, ledger(user, key), "telegram.topic", {
          key,
          threadId: null,
          missing: stale,
        });
        return this.thread(user, key);
      })()
        .catch(() => undefined)
        .finally(() => this.recovering.delete(id));
      this.recovering.set(id, pending);
    }
    return pending;
  }

  /**
   * Sends into a topic. If Telegram says the topic is gone (the owner deleted it), the
   * stored id is forgotten and the send is retried once in a newly created topic. Any
   * other rejection about the topic retries once in General.
   */
  async send<T>(
    user: string,
    key: TopicKey,
    send: (extra: { message_thread_id?: number }) => Promise<T>,
  ): Promise<T> {
    // Topics are optional: any failure to find one sends to General instead.
    const thread = await this.thread(user, key).catch(() => undefined);
    try {
      return await send(inThread(thread));
    } catch (error) {
      if (!thread) throw error;
      if (missing(error)) {
        opsLog("telegram.topic_missing", "warn", { kind: key });
        return send(inThread(await this.recover(user, key, thread)));
      }
      if (!unusable(error)) throw error;
      opsLog("telegram.topic_unusable", "warn", {
        kind: key,
        ...errorFields(error),
      });
      return send({});
    }
  }
}
