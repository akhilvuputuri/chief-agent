import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
const userSchema = z.object({ id: z.number().int().positive().safe() });
const sessionSchema = z
  .object({ user: z.string().regex(/^\d+$/), expires: z.number().int() })
  .strict();
export class MiniAuth {
  private key: Buffer;
  constructor(
    private token: string,
    private allowed: Set<string>,
    private now = () => Date.now(),
  ) {
    this.key = createHmac("sha256", token)
      .update("companion-miniapp-session-v1")
      .digest();
  }
  authenticate(raw: string) {
    if (raw.length > 16000) throw new Error("Unauthorized");
    const params = new URLSearchParams(raw);
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) throw new Error("Unauthorized");
    const hash = params.get("hash") ?? "";
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Unauthorized");
    params.delete("hash");
    const data = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secret = createHmac("sha256", "WebAppData")
      .update(this.token)
      .digest();
    const expected = createHmac("sha256", secret).update(data).digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, "hex")))
      throw new Error("Unauthorized");
    const date = params.get("auth_date") ?? "";
    const age = this.now() / 1000 - Number(date);
    if (!/^\d{1,12}$/.test(date) || age > 300 || age < -30)
      throw new Error("Unauthorized");
    const user = String(
      userSchema.parse(JSON.parse(params.get("user") ?? "{}")).id,
    );
    if (!this.allowed.has(user)) throw new Error("Unauthorized");
    const expires = Math.floor(this.now() / 1000) + 1800;
    const encoded = Buffer.from(JSON.stringify({ user, expires })).toString(
      "base64url",
    );
    return {
      token:
        encoded +
        "." +
        createHmac("sha256", this.key).update(encoded).digest("base64url"),
      expires,
    };
  }
  verify(header: string | undefined) {
    if (!header || !header.startsWith("Bearer ") || header.length > 1000)
      throw new Error("Unauthorized");
    const [encoded, signature, ...rest] = header.slice(7).split(".");
    if (!encoded || !signature || rest.length) throw new Error("Unauthorized");
    const expected = createHmac("sha256", this.key).update(encoded).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Unauthorized");
    const session = sessionSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString()),
    );
    if (session.expires <= this.now() / 1000 || !this.allowed.has(session.user))
      throw new Error("Unauthorized");
    return session.user;
  }
}
