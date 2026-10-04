// Topics in the bot's private chat (Telegram threaded mode). Chief owns a small fixed set
// of topics and posts scheduled output there; General stays the main conversation.
// Everything degrades to General: with threaded mode off, the switch off, or any failure
// to create a topic, sends simply leave out message_thread_id.
import { createHash } from "node:crypto";
import type { Api } from "grammy";
import type { Database } from "./db.js";
import { event } from "./db.js";
import { errorFields, opsLog } from "./ops-log.js";

export type TopicKey = "news" | "markets" | "coding";
// icon_color must be one of Telegram's six topic colours.
const topics = {
  news: { name: "News", icon_color: 0x6fb9f0 },
  markets: { name: "Markets", icon_color: 0x8eee98 },
  coding: { name: "Coding", icon_color: 0xffd67e },
} as const satisfies Record<TopicKey, { name: string; icon_color: number }>;

/**
 * Phase 2: a message typed in one of these topics goes first to this agent type. Only
 * topics whose agent matches what people ask there: the news and stocks agents manage
 * bulletin and alert settings, while questions typed in News or Markets usually need the
 * web, so those topics only tell Chief where the message came from.
 */
const keys = Object.keys(topics) as TopicKey[];

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

type TopicApi = Pick<Api, "getMe" | "createForumTopic"> &
  Partial<Pick<Api, "editForumTopic">>;

// Thread ids live in the existing events table (no migration), one stable run id per
// owner and topic, so the lookup uses the run index. The newest row wins; a null
// threadId records that the topic was deleted in Telegram.
const ledger = (user: string, key: TopicKey | "updates" | "email") => {
  const h = createHash("sha256")
    .update(`telegram-topic:${user}:${key === "coding" ? "updates" : key}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export class TelegramTopics {
  private state?: { on: boolean; at: number };
  private checking?: Promise<boolean>;
  // Topics created in this process, in case recording one failed.
  private known = new Map<string, number>();
  private creating = new Map<string, Promise<number | undefined>>();
  private recovering = new Map<string, Promise<number | undefined>>();
  constructor(
    private db: Database,
    private api: TopicApi,
    private enabled = true,
  ) {}

  /**
   * Whether the bot has threaded mode on. "On" is kept until restart; "off" is checked
   * again after ten minutes, so turning the BotFather switch on needs no restart. A
   * failed check is retried on the next send.
   */
  private async available() {
    if (!this.enabled) return false;
    const state = this.state;
    if (state && (state.on || Date.now() - state.at < 600_000)) return state.on;
    this.checking ??= this.api
      .getMe()
      .then(
        (me) => {
          this.state = { on: !!me.has_topics_enabled, at: Date.now() };
          return this.state.on;
        },
        (error) => {
          opsLog("telegram.topics_check_failed", "warn", errorFields(error));
          return false;
        },
      )
      .finally(() => (this.checking = undefined));
    return this.checking;
  }

  /** The topic's thread id, creating the topic once. Undefined means "send to General". */
  async thread(user: string, key: TopicKey): Promise<number | undefined> {
    if (!(await this.available())) return undefined;
    const id = `${user}:${key}`;
    // A failed read is not evidence the topic is gone: use the one this process knows,
    // or let send() fall back to General rather than create a duplicate.
    const saved = await this.stored(user, key).catch((error) => {
      if (this.known.has(id)) return this.known.get(id);
      throw error;
    });
    if (typeof saved === "number") return saved;
    // Created earlier in this process but never recorded (a null row means deleted).
    if (saved === undefined && this.known.has(id)) return this.known.get(id);
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
      this.known.set(`${user}:${key}`, topic.message_thread_id);
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

  /** Creates any missing topics, so the owner can write in them before Chief posts there. */
  async ensure(user: string) {
    // Keep the Updates ledger/thread identity: only rename the visible topic. Historical
    // messages, owner origins and explicit feed references remain valid.
    if ((await this.available()) && this.api.editForumTopic) {
      const saved = (
        await this.db.query(
          "SELECT data FROM events WHERE user_id=$1 AND run_id=$2 AND type='telegram.topic' ORDER BY id DESC LIMIT 1",
          [user, ledger(user, "coding")],
        )
      ).rows[0]?.data;
      const old =
        saved ??
        (
          await this.db.query(
            "SELECT data FROM events WHERE user_id=$1 AND run_id=$2 AND type='telegram.topic' ORDER BY id DESC LIMIT 1",
            [user, ledger(user, "email")],
          )
        ).rows[0]?.data;
      if (typeof old?.threadId === "number" && old.key !== "coding") {
        // Even an uncertain rename is not evidence that the existing topic is gone.
        this.known.set(`${user}:coding`, old.threadId);
        try {
          await this.api.editForumTopic(user, old.threadId, { name: "Coding" });
          await event(this.db, user, ledger(user, "coding"), "telegram.topic", {
            key: "coding",
            threadId: old.threadId,
          });
        } catch (error) {
          opsLog("telegram.topic_retire_failed", "warn", errorFields(error));
        }
      }
    }
    for (const key of keys) await this.thread(user, key).catch(() => undefined);
  }

  /** Which of Chief's topics a thread is, if any. A failed lookup means none. */
  async keyFor(user: string, thread: number | undefined) {
    if (!thread || !(await this.available())) return undefined;
    for (const key of keys) {
      const id = `${user}:${key}`;
      const saved = await this.stored(user, key).catch(() =>
        this.known.get(id),
      );
      if (
        saved === thread ||
        (saved === undefined && this.known.get(id) === thread)
      )
        return key;
    }
    return undefined;
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
    send: (
      extra: { message_thread_id?: number },
      notice?: string,
    ) => Promise<T>,
  ): Promise<T> {
    // Topics are optional: any failure to find one sends to General instead.
    const thread = await this.thread(user, key).catch(() => undefined);
    try {
      return await send(inThread(thread));
    } catch (error) {
      if (!thread) throw error;
      if (missing(error)) {
        opsLog("telegram.topic_missing", "warn", { kind: key });
        const recreated = await this.recover(user, key, thread);
        try {
          return await send(
            inThread(recreated),
            recreated
              ? `Topic recreated. Say 'stop the ${key === "news" ? "news bulletin" : key === "markets" ? "stock alerts" : "coding job"}' in General to turn it off.`
              : undefined,
          );
        } catch (retryError) {
          if (!unusable(retryError)) throw retryError;
          return send({});
        }
      }
      if (!unusable(error)) throw error;
      opsLog("telegram.topic_unusable", "warn", {
        kind: key,
        ...errorFields(error),
      });
      return send({});
    }
  }

  /** Captured origins survive restarts; retired Updates feeds explicitly move to General. */
  async deliver<T>(
    user: string,
    target: import("./delivery-routing.js").Destination,
    send: (
      extra: { message_thread_id?: number },
      notice?: string,
    ) => Promise<T>,
  ) {
    if (target.kind === "topic")
      return target.topic === "updates"
        ? send({})
        : this.send(user, target.topic, send);
    if (target.kind === "general") return send({});
    try {
      return await send(inThread(target.threadId));
    } catch (error) {
      if (!missing(error) && !unusable(error)) throw error;
      const key = await this.keyFor(user, target.threadId);
      if (key && missing(error)) {
        const replacement = await this.recover(user, key, target.threadId);
        try {
          return await send(
            inThread(replacement),
            replacement
              ? "Topic recreated. Change its schedule in General to stop future updates."
              : undefined,
          );
        } catch (retryError) {
          if (!unusable(retryError)) throw retryError;
        }
      }
      return send({});
    }
  }

  async capture(
    user: string,
    target: import("./delivery-routing.js").Destination,
  ): Promise<import("./delivery-routing.js").Destination> {
    if (target.kind !== "topic") return target;
    if (target.topic === "updates") return { kind: "general" };
    const thread = await this.thread(user, target.topic).catch(() => undefined);
    return thread ? { kind: "thread", threadId: thread } : { kind: "general" };
  }
}
