import { type CalendarDraft, validateDraft } from "./calendar-draft.js";
import { boundedBytes } from "./providers.js";
export async function googleJson(r: Response) {
  if (!r.ok) throw new Error(`Google request failed (${r.status})`);
  return JSON.parse(new TextDecoder().decode(await boundedBytes(r, 2000000)));
}
/** Creation stopped before the insert request was sent, so no event can exist. */
export class CalendarNotSentError extends Error {}
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
  const r = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  // invalid_grant (expired/revoked refresh token) is a 400; name it so tools report reconnection.
  if (r.status === 400 || r.status === 401)
    throw new Error(
      `Google authorization expired or was revoked (${r.status}); reconnect required`,
    );
  const t = await googleJson(r);
  if (typeof t.access_token !== "string")
    throw new Error("Invalid access token");
  return t.access_token as string;
}
export class CalendarTools {
  constructor(
    private c: GoogleConfig,
    private request: typeof fetch = fetch,
  ) {}
  private async headers(user: string) {
    if (!this.c.owner || user !== this.c.owner)
      throw new Error("Calendar is not connected for this user");
    const token = await googleToken(this.c, this.request);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const profile = await googleJson(
      await this.request("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }),
    );
    if (profile.email?.toLowerCase() !== this.c.email.toLowerCase())
      throw new Error("Wrong Google account");
    return headers;
  }
  async create(user: string, approval: string, input: CalendarDraft) {
    let draft: CalendarDraft, headers: Record<string, string>, id: string;
    try {
      draft = validateDraft(input);
      headers = await this.headers(user);
      id = approval.replaceAll("-", "");
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid approval ID");
    } catch (e) {
      throw new CalendarNotSentError(
        e instanceof Error ? e.message : "Calendar request was not sent",
      );
    }
    return googleJson(
      await this.request(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none",
        {
          method: "POST",
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          body: JSON.stringify({
            id,
            summary: draft.title,
            description: draft.description,
            location: draft.location,
            start: { dateTime: draft.start, timeZone: "Asia/Singapore" },
            end: { dateTime: draft.end, timeZone: "Asia/Singapore" },
            extendedProperties: { private: { companionApproval: approval } },
          }),
        },
      ),
    );
  }
  async findCreated(user: string, approval: string) {
    if (!/^[0-9a-f-]{36}$/.test(approval))
      throw new Error("Invalid approval ID");
    const headers = await this.headers(user);
    const response = await this.request(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/" +
        approval.replaceAll("-", ""),
      { headers, redirect: "error", signal: AbortSignal.timeout(15000) },
    );
    if (response.status === 404) return null;
    const result = await googleJson(response);
    if (
      result.extendedProperties?.private?.companionApproval !== approval ||
      result.status === "cancelled"
    )
      throw new Error("Event identity mismatch");
    return result;
  }
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
