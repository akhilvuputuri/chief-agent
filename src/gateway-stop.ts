/** Docker's default stop grace is 10 s; finish (or give up) before SIGKILL. */
export const STOP_DEADLINE_MS = 8000;
/** Part of the deadline kept for closing HTTP and the database after handlers. */
export const CLOSE_RESERVE_MS = 1500;

export interface StopSteps {
  /** Stop fetching Telegram updates. Resolves when the fetch loop ends, not when handlers finish. */
  stopIntake(): Promise<void>;
  /** Telegram updates still being handled. */
  handlersRunning(): number;
  closeHttp(): Promise<void>;
  closeDatabase(): Promise<void>;
}
export interface StopResult {
  complete: boolean;
  /** The Telegram fetch loop ended; until it does it may still confirm updates. */
  intakeStopped: boolean;
  handlersLeft: number;
  httpClosed: boolean;
  databaseClosed: boolean;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Run a step so that a synchronous throw becomes a rejection, not an escape. */
const attempt = (step: () => Promise<void>) => Promise.resolve().then(step);
async function within(promise: Promise<void>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop intake, let running handlers finish, then close HTTP and the database,
 * all within one deadline. Handlers hold database clients, so the database closes
 * last; a step that cannot finish in time is reported rather than awaited forever
 * (an upgrade socket left open, for example, keeps app.close() pending). */
export async function stopGateway(
  steps: StopSteps,
  deadlineMs = STOP_DEADLINE_MS,
  pollMs = 100,
  closeReserveMs = Math.min(CLOSE_RESERVE_MS, deadlineMs / 2),
): Promise<StopResult> {
  const deadline = Date.now() + deadlineMs;
  const left = () => Math.max(0, deadline - Date.now());
  // Handlers may not use the close steps' share, so a slow handler cannot turn
  // "HTTP or the database hung" into "never had time to close".
  const handlersLeftTime = () => Math.max(0, left() - closeReserveMs);
  const intakeStopped = await within(
    attempt(() => steps.stopIntake()),
    handlersLeftTime(),
  );
  while (steps.handlersRunning() > 0 && handlersLeftTime() > 0)
    await pause(Math.min(pollMs, handlersLeftTime()));
  const handlersLeft = steps.handlersRunning();
  const httpClosed = await within(
    attempt(() => steps.closeHttp()),
    left(),
  );
  const databaseClosed = await within(
    attempt(() => steps.closeDatabase()),
    left(),
  );
  return {
    complete:
      intakeStopped && handlersLeft === 0 && httpClosed && databaseClosed,
    intakeStopped,
    handlersLeft,
    httpClosed,
    databaseClosed,
  };
}
