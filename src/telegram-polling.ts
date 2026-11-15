// Telegram long polling that keeps listening for the life of the process (journal 196).
//
// @grammyjs/runner's defaults suit a large bot that a supervisor restarts, not one
// always-on personal bot: after a failed getUpdates it waits 100 ms and doubles the wait
// after every consecutive failure, gives up after 15 hours, and ends its loop at once on a
// 401 or 409. The loop's promise is not awaited by the library, so its rejection ends
// polling; with `silent` none of it was printed. Here the runner retries at one steady
// interval and never gives up, every getUpdates outcome is recorded, an ended loop is
// restarted on the same fetcher (so the update offset is kept), and an outage reaches the
// owner and the health endpoint.
import { run, type RunnerHandle } from "@grammyjs/runner";
import type { Bot, Context } from "grammy";
import { errorFields, opsLog, type OpsFields } from "./ops-log.js";

/** Why getUpdates did not return updates. Fixed names, never Telegram's text. */
export type PollFailure =
  | "network"
  | "timeout"
  | "conflict"
  | "unauthorized"
  | "rate_limited"
  | "api_error";
export type PollingState =
  | "starting"
  | "polling"
  | "failing"
  | "stale"
  | "conflict"
  | "unauthorized"
  | "stopped";
export interface PollingStatus {
  state: PollingState;
  /** Seconds since the last getUpdates that Telegram answered; absent before the first. */
  lastPollAgeS?: number;
  /** getUpdates calls that failed since the last one that succeeded. */
  pollFailures: number;
  /** Updates still being handled (they hold the runner's intake slots). */
  handlersRunning: number;
}
export interface PollingOptions {
  /** The existing owner-notice path. Best effort: a failure is ignored. */
  notifyOwner(text: string): Promise<void>;
  allowedUpdates: ("message" | "callback_query")[];
  concurrency: number;
  /** Wait between attempts after a failure, and before restarting an ended loop. */
  retryMs?: number;
  /** No answered getUpdates for this long is an outage: owner notice, stale health. */
  staleMs?: number;
  /** Ceiling for one getUpdates call (the long poll is 30 s). */
  pollDeadlineMs?: number;
  /** While an outage lasts, repeat its log lines at most this often. */
  logEveryMs?: number;
  checkEveryMs?: number;
  timeZone?: string;
}
export interface Polling {
  /** Stop fetching. Resolves when the fetch loop ends, like RunnerHandle.stop(). */
  stop(): Promise<void> | undefined;
  size(): number;
  status(): PollingStatus;
}

export const POLL_RETRY_MS = 5_000;
export const POLL_STALE_MS = 10 * 60_000;
const LONG_POLL_S = 30;

function telegramCode(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { error_code?: unknown }).error_code;
  return typeof code === "number" ? code : undefined;
}
function classify(code: number | undefined, error?: unknown): PollFailure {
  if (code === 401) return "unauthorized";
  if (code === 409) return "conflict";
  if (code === 429) return "rate_limited";
  if (code !== undefined) return "api_error";
  const inner = (error as { error?: unknown } | undefined)?.error;
  return inner instanceof Error && inner.name === "AbortError"
    ? "timeout"
    : "network";
}
/** grammY's HttpError keeps the network error on `.error`, not `.cause`. */
function pollErrorFields(error: unknown): OpsFields {
  const fields = errorFields(error);
  const inner = (error as { error?: unknown } | undefined)?.error;
  if (!(inner instanceof Error)) return fields;
  const innerFields = errorFields(inner);
  return {
    ...fields,
    causeCategory: innerFields.errorCategory,
    ...(innerFields.errorCode !== undefined
      ? { errorCode: innerFields.errorCode }
      : {}),
  };
}

export function outageLength(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(ms / 86_400_000)} days`;
}

const reasons: Record<PollFailure | "handlers_busy" | "no_answer", string> = {
  conflict:
    " because another program is fetching updates with my bot token. Stop the other one; ",
  unauthorized: " because Telegram rejected my bot token. ",
  rate_limited: " because Telegram is asking me to slow down. ",
  api_error: " because Telegram refused my requests. ",
  network: " because Telegram could not be reached. ",
  timeout: " because Telegram could not be reached. ",
  handlers_busy: " because earlier messages are still being handled. ",
  no_answer: ". ",
};

/** Start long polling. The caller must not start the runner itself. */
export function startPolling<C extends Context>(
  bot: Bot<C>,
  options: PollingOptions,
): Polling {
  const retryMs = options.retryMs ?? POLL_RETRY_MS;
  const staleMs = options.staleMs ?? POLL_STALE_MS;
  const pollDeadlineMs = options.pollDeadlineMs ?? (LONG_POLL_S + 30) * 1000;
  const logEveryMs = options.logEveryMs ?? 10 * 60_000;
  const timeZone = options.timeZone ?? "Asia/Singapore";
  const clock = (ms: number) =>
    new Intl.DateTimeFormat("en-SG", {
      timeZone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(ms);
  const notify = (text: string) => {
    void options.notifyOwner(text).catch(() => {});
  };

  const startedAt = Date.now();
  let lastSuccessAt: number | undefined;
  let failures = 0;
  let lastFailure: PollFailure | undefined;
  let lastFailureLogAt = 0;
  let outageNotified = false;
  let ends = 0;
  let lastEndLogAt = 0;
  let stopping = false;
  let restartTimer: NodeJS.Timeout | undefined;

  const age = (now: number) => now - (lastSuccessAt ?? startedAt);
  const ageS = (now: number) =>
    lastSuccessAt === undefined
      ? undefined
      : Math.round((now - lastSuccessAt) / 1000);

  /** `calledAt`: an idle long poll answers 30 s after it was made, but Telegram was
   * reachable from the moment of the call, so the outage is measured to it. */
  function succeeded(calledAt: number) {
    const now = Date.now();
    const since = lastSuccessAt ?? startedAt;
    const gap = Math.max(0, calledAt - since);
    if (failures > 0 || outageNotified || gap >= staleMs)
      opsLog("telegram.poll_recovered", "info", {
        outageS: Math.round(gap / 1000),
        attempt: failures,
        kind: lastFailure ?? "no_answer",
      });
    // Once per outage: the line goes out on the first answered poll after it.
    if (outageNotified || gap >= staleMs)
      notify(
        `I was not receiving messages for about ${outageLength(gap)}, since ${clock(since)}. Messages from that time are arriving now, except anything sent more than 24 hours ago, which Telegram did not keep: please send that again.`,
      );
    lastSuccessAt = now;
    failures = 0;
    lastFailure = undefined;
    outageNotified = false;
    ends = 0;
  }

  function failed(kind: PollFailure, fields: OpsFields, code?: number) {
    const now = Date.now();
    failures++;
    lastFailure = kind;
    // The first failure, then at most once per logEveryMs while the outage lasts.
    if (failures > 1 && now - lastFailureLogAt < logEveryMs) return;
    lastFailureLogAt = now;
    opsLog("telegram.poll_failed", failures === 1 ? "warn" : "error", {
      ...fields,
      httpStatus: code,
      kind,
      attempt: failures,
      lastPollAgeS: ageS(now),
    });
  }

  // Every getUpdates passes through here, whichever runner loop made it.
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method !== "getUpdates") return prev(method, payload, signal);
    // grammY's own timeout (500 s) is sized for uploads; a 30 s long poll that has not
    // answered after pollDeadlineMs is a dead connection, and is retried.
    const deadline = new AbortController();
    const abort = () => deadline.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort);
    const timer = setTimeout(abort, pollDeadlineMs);
    const calledAt = Date.now();
    try {
      // grammY types its signal with the abort-controller shim; node-fetch accepts Node's.
      const result = await prev(
        method,
        payload,
        deadline.signal as unknown as Parameters<typeof prev>[2],
      );
      if (result.ok) succeeded(calledAt);
      else {
        const code = telegramCode(result);
        failed(classify(code), { errorCategory: "telegram_api" }, code);
      }
      return result;
    } catch (error) {
      // A stop aborts the call on purpose.
      if (!signal?.aborted)
        failed(classify(undefined, error), pollErrorFields(error));
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  });

  const handle: RunnerHandle = run(bot, {
    runner: {
      // Errors are logged above without their text; the library prints whole error objects.
      silent: true,
      // A constant wait: a long outage is not followed by an equally long sleep.
      retryInterval: retryMs,
      // Never give up: the library's 15 hours ended polling for the life of the process.
      maxRetryTime: Number.POSITIVE_INFINITY,
      fetch: { allowed_updates: options.allowedUpdates, timeout: LONG_POLL_S },
    },
    sink: { concurrency: options.concurrency },
  });

  // The runner still ends its loop on a 401 or 409, or on any other throw. Its promise is
  // watched here, so the end is recorded and polling restarts on the same fetcher.
  function watch(task: Promise<void> | undefined) {
    task?.then(
      () => ended(undefined),
      (error: unknown) => ended(error),
    );
  }
  function ended(error: unknown) {
    if (stopping) return;
    const now = Date.now();
    ends++;
    const code = telegramCode(error);
    const kind = error === undefined ? "ended" : classify(code, error);
    const log = ends === 1 || now - lastEndLogAt >= logEveryMs;
    if (log) {
      lastEndLogAt = now;
      opsLog("telegram.polling_stopped", "error", {
        ...(error === undefined ? {} : pollErrorFields(error)),
        httpStatus: code,
        kind,
        attempt: ends,
      });
    }
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (stopping) return;
      // stop() resets the finished update source; the fetcher, its offset and the sink
      // with its running handlers stay, so no update is skipped or fetched again.
      void handle.stop();
      handle.start();
      if (log)
        opsLog("telegram.polling_restarted", "info", { kind, attempt: ends });
      watch(handle.task());
    }, retryMs);
  }
  watch(handle.task());

  function reason(): keyof typeof reasons {
    if (lastFailure) return lastFailure;
    return handle.size() >= options.concurrency ? "handlers_busy" : "no_answer";
  }
  const checker = setInterval(() => {
    if (stopping || outageNotified) return;
    const now = Date.now();
    if (age(now) < staleMs) return;
    outageNotified = true;
    const why = reason();
    opsLog("telegram.poll_stale", "error", {
      kind: why,
      attempt: failures,
      lastPollAgeS: ageS(now),
      handlersRunning: handle.size(),
    });
    notify(
      `I have not received any Telegram messages for ${outageLength(age(now))}${reasons[why]}I keep trying every ${Math.round(retryMs / 1000)} seconds and will tell you when messages come through again.`,
    );
  }, options.checkEveryMs ?? 30_000);
  checker.unref?.();

  return {
    stop() {
      stopping = true;
      clearInterval(checker);
      if (restartTimer) clearTimeout(restartTimer);
      return handle.stop();
    },
    size: () => handle.size(),
    status() {
      const now = Date.now();
      const state: PollingState = stopping
        ? "stopped"
        : lastFailure === "unauthorized"
          ? "unauthorized"
          : lastFailure === "conflict"
            ? "conflict"
            : age(now) >= staleMs
              ? "stale"
              : failures > 0
                ? "failing"
                : lastSuccessAt === undefined
                  ? "starting"
                  : "polling";
      return {
        state,
        lastPollAgeS: ageS(now),
        pollFailures: failures,
        handlersRunning: handle.size(),
      };
    },
  };
}
