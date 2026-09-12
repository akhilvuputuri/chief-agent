import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import type { Database } from "./db.js";
import { event } from "./db.js";
import { answerSchema, type Delivery } from "./answer.js";
import { formatTelegram } from "./telegram-format.js";
import {
  initialPosition,
  renderView,
  type Action,
  type Position,
  type View,
} from "./telegram-view-render.js";

interface State {
  version: 1;
  chat: string;
  message?: number;
  view: View;
  position: Position;
  actions: Action[][];
  revision: number;
  created: number;
  expires: number;
  firstTap?: number;
  lastEdit?: number;
}
const ttl = 7 * 86400000;
export const viewCallback = /^v:([0-9a-f]{32}):(\d{1,6}):(\d{1,3})$/;
const uuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const keyboard = (id: string, state: State) => {
  let index = 0;
  return {
    inline_keyboard: state.actions.map((row) =>
      row.map((a) => ({
        text: a.label,
        callback_data: `v:${id.replaceAll("-", "")}:${state.revision}:${index++}`,
      })),
    ),
  };
};
type ViewApi = Pick<Api, "sendMessage" | "editMessageText">;

/** Read-only UI controller. The mutable event is view state, not an approval or tool receipt.
 * SQL leases serialize edits across handlers; callback actions come only from the saved keyboard. */
export class TelegramViews {
  constructor(
    private db: Database,
    private api: ViewApi,
    private now = () => Date.now(),
  ) {}
  async open(
    user: string,
    chat: string,
    view: View,
    run: string = randomUUID(),
  ) {
    const id = randomUUID();
    if (view.kind === "task" && !view.id) {
      view = {
        ...view,
        id: (
          await this.db.query(
            "SELECT id FROM work_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
            [user],
          )
        ).rows[0]?.id,
      };
    }
    const rendered = await renderView(this.db, user, view, initialPosition());
    const state: State = {
      version: 1,
      chat,
      view,
      position: initialPosition(),
      actions: rendered.actions,
      revision: 0,
      created: this.now(),
      expires: this.now() + ttl,
    };
    await event(
      this.db,
      user,
      id,
      "telegram.view_state",
      state as unknown as Record<string, unknown>,
    );
    const sent = await this.api.sendMessage(chat, rendered.text, {
      entities: rendered.entities,
      reply_markup: keyboard(id, state),
      link_preview_options: { is_disabled: true },
    });
    state.message = sent.message_id;
    await this.db.query(
      "UPDATE events SET data=$3::jsonb WHERE run_id=$1 AND user_id=$2 AND type='telegram.view_state'",
      [id, user, JSON.stringify(state)],
    );
    await event(this.db, user, run, "telegram.view_opened", {
      viewId: id,
      kind: view.kind,
      messageId: sent.message_id,
    });
    return id;
  }
  async navigate(
    user: string,
    chat: string,
    message: number,
    callback: string,
  ) {
    const match = viewCallback.exec(callback);
    if (!match) return "View unavailable.";
    const id = uuid(match[1]!);
    const lease = randomUUID();
    // Message binding is essential: a forwarded/copied keyboard cannot reveal another user's state.
    const rows = (
      await this.db.query(
        `UPDATE events SET data=data || jsonb_build_object('lease',$5::text,'leaseUntil',$6::bigint) WHERE run_id=$1 AND user_id=$2 AND type='telegram.view_state' AND data->>'chat'=$3 AND data->>'message'=$4 AND (COALESCE((data->>'leaseUntil')::bigint,0)<$7) RETURNING data`,
        [
          id,
          user,
          chat,
          String(message),
          lease,
          this.now() + 30000,
          this.now(),
        ],
      )
    ).rows;
    if (!rows.length) return "View unavailable or updating. Try again.";
    try {
      const state = rows[0].data as State;
      if (state.version !== 1 || state.expires < this.now())
        return "This view expired. Open a new view with /status, /roles or another view command.";
      if (state.lastEdit && this.now() - state.lastEdit < 750)
        return "View just updated. Try again in a moment.";
      const stale = Number(match[2]) !== state.revision;
      const action = state.actions.flat()[Number(match[3])];
      if (!stale && !action) return "View action unavailable.";
      // Old buttons only refresh their current position, never apply a different action by index.
      const position = stale ? state.position : action!.position;
      const rendered = await renderView(this.db, user, state.view, position);
      const next: State = {
        ...state,
        position,
        actions: rendered.actions,
        revision: (state.revision + 1) % 1000000,
        firstTap: state.firstTap ?? this.now(),
        lastEdit: this.now(),
      };
      await this.api.editMessageText(
        chat,
        message,
        rendered.text,
        {
          entities: rendered.entities,
          reply_markup: keyboard(id, next),
          link_preview_options: { is_disabled: true },
        },
        AbortSignal.timeout(10000) as unknown as Parameters<
          Api["editMessageText"]
        >[4],
      );
      await this.db.query(
        "UPDATE events SET data=$4::jsonb WHERE run_id=$1 AND user_id=$2 AND type='telegram.view_state' AND data->>'lease'=$3",
        [id, user, lease, JSON.stringify(next)],
      );
      await event(this.db, user, id, "telegram.view_tapped", {
        viewId: id,
        kind: state.view.kind,
        stale,
        action: stale ? "refresh" : Number(match[3]),
        firstTapMs: state.firstTap ? null : this.now() - state.created,
      });
      return undefined;
    } catch {
      // No model or external write ran. A retry refreshes the saved view if an edit had an ambiguous outcome.
      await event(this.db, user, id, "telegram.view_failed", { viewId: id });
      return "Could not update this view. Try Refresh or open a new view.";
    } finally {
      await this.db.query(
        "UPDATE events SET data=data - 'lease' - 'leaseUntil' WHERE run_id=$1 AND user_id=$2 AND type='telegram.view_state' AND data->>'lease'=$3",
        [id, user, lease],
      );
    }
  }
  async deliver(
    user: string,
    chat: string,
    input: string | Delivery,
    kind: "answer" | "progress" | "schedule" = "answer",
  ) {
    const delivery = typeof input === "string" ? { reply: input } : input;
    const answer = answerSchema.parse({
      reply: delivery.reply,
      records: delivery.records,
      numbers: delivery.numbers,
      sections: delivery.sections,
      sources: delivery.sources,
    });
    const parts = formatTelegram(answer.reply);
    const interactive =
      parts.length > 1 ||
      formatTelegram(answer.reply, 1800).length > 1 ||
      !!(
        answer.records?.length ||
        answer.sections?.length ||
        answer.sources?.length ||
        answer.numbers?.length
      );
    const run = delivery.runId ?? randomUUID();
    if (interactive)
      await this.open(user, chat, { kind: "answer", answer }, run);
    else
      for (const part of parts)
        await this.api.sendMessage(chat, part.text, {
          entities: part.entities,
          link_preview_options: { is_disabled: true },
        });
    // Never hide authoritative approval notices behind a disclosure button.
    let noticeMessages = 0;
    for (const notice of delivery.notices ?? [])
      for (const part of formatTelegram(notice)) {
        await this.api.sendMessage(chat, part.text, {
          entities: part.entities,
        });
        noticeMessages++;
      }
    await event(this.db, user, run, "telegram.delivered", {
      kind,
      characters: answer.reply.length,
      legacyChunks: parts.length,
      messages: interactive ? 1 : parts.length,
      noticeMessages,
      interactive,
    });
  }
}
