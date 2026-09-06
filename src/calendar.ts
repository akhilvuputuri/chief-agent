import { boundedBytes } from "./providers.js";
export async function googleJson(r: Response) {
  if (!r.ok) throw new Error(`Google request failed (${r.status})`);
  return JSON.parse(new TextDecoder().decode(await boundedBytes(r, 2000000)));
}
export type GoogleConfig = {
  owner: string;
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};
export async function googleToken(
  c: GoogleConfig,
  request: typeof fetch = fetch,
) {
  if (!c.refreshToken) throw new Error("Google connection is not configured");
  const t = await googleJson(
    await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: "refresh_token",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    }),
  );
  if (typeof t.access_token !== "string")
    throw new Error("Invalid access token");
  return t.access_token as string;
}
export class CalendarTools {
  constructor(
    private c: GoogleConfig,
    private request: typeof fetch = fetch,
  ) {}
  async list(user: string, start: string, end: string) {
    if (!this.c.owner || user !== this.c.owner)
      throw new Error("Calendar is not connected for this user");
    const duration = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 31 * 86400000)
      throw new Error("Calendar range must be between 0 and 31 days");
    const token = await googleToken(this.c, this.request);
    const headers = { Authorization: `Bearer ${token}` };
    const profile = await googleJson(
      await this.request("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }),
    );
    if (profile.email?.toLowerCase() !== this.c.email.toLowerCase())
      throw new Error("Wrong Google account");
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    url.search = new URLSearchParams({
      timeMin: start,
      timeMax: end,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
      timeZone: "Asia/Singapore",
    }).toString();
    const r = await googleJson(
      await this.request(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }),
    );
    return {
      untrusted: true,
      calendar: "primary",
      truncated: !!r.nextPageToken,
      events: (r.items ?? []).map((e: any) => ({
        id: e.id,
        title: e.summary ?? "(Untitled)",
        start: e.start,
        end: e.end,
        location: e.location,
        url: e.htmlLink,
        status: e.status,
      })),
    };
  }
}
