/** Docker's default stop grace is 10 s; finish (or give up) before SIGKILL. */
export const STOP_DEADLINE_MS = 8000;

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
  handlersLeft: number;
  httpClosed: boolean;
  databaseClosed: boolean;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
): Promise<StopResult> {
  const deadline = Date.now() + deadlineMs;
  const left = () => Math.max(0, deadline - Date.now());
  await within(steps.stopIntake(), left());
  while (steps.handlersRunning() > 0 && left() > 0)
    await pause(Math.min(pollMs, left()));
  const handlersLeft = steps.handlersRunning();
  const httpClosed = await within(steps.closeHttp(), left());
  const databaseClosed = await within(steps.closeDatabase(), left());
  return {
    complete: handlersLeft === 0 && httpClosed && databaseClosed,
    handlersLeft,
    httpClosed,
    databaseClosed,
  };
}
