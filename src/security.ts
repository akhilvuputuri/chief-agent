import { timingSafeEqual } from "node:crypto";
export function authorized(header: string | undefined, token: string) {
  const got = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
export function allowedChat(
  user: number | undefined,
  chatType: string | undefined,
  ids: Set<string>,
) {
  return user !== undefined && chatType === "private" && ids.has(String(user));
}
// Defense in depth: page retrieval happens at the hosted provider, never on this network.
export function publicHttps(input: string) {
  const u = new URL(input);
  const h = u.hostname.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !h.includes(".") ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(h) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h) ||
    h.includes(":")
  )
    throw new Error("Use a public HTTPS hostname");
  return u.href;
}
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}
