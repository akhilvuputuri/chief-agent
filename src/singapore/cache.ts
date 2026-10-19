/**
 * In-memory TTL cache with in-flight sharing: concurrent callers for one key share
 * a single upstream request, and failures are never cached.
 */
export class TtlCache {
  private readonly values = new Map<string, { at: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly now: () => number = Date.now) {}
  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as T;
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;
    const next = load()
      .then((value) => {
        this.values.set(key, { at: this.now(), value });
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, next);
    return next;
  }
  /** When the cached value for key was fetched, if any. */
  fetchedAt(key: string) {
    return this.values.get(key)?.at;
  }
}
