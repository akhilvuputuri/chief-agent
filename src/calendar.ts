import {
  type CalendarDraft,
  dayAfter,
  dayBefore,
  validateDraft,
} from "./calendar-draft.js";
import { boundedBytes } from "./providers.js";
import { z } from "zod";
const calendarTime = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dateTime: z.string().datetime({ offset: true }).optional(),
    timeZone: z.string().optional(),
  })
  .passthrough()
  .refine(
    (t) => !!(t.date || t.dateTime),
    "Calendar time requires date or dateTime",
  );
const monitoringEvent = z
  .object({
    id: z.string().min(1).max(1024),
    status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
    recurringEventId: z.string().min(1).max(1024).optional(),
    originalStartTime: calendarTime.optional(),
    attendeesOmitted: z.boolean().optional(),
    summary: z.string().optional(),
    location: z.string().optional(),
    htmlLink: z.string().url().optional(),
    start: calendarTime.optional(),
    end: calendarTime.optional(),
    attendees: z
      .array(
        z
          .object({
            email: z.string().optional(),
            self: z.boolean().optional(),
            resource: z.boolean().optional(),
            responseStatus: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .refine(
    (e) =>
      e.status === "cancelled" ||
      (!!(e.start?.date || e.start?.dateTime) &&
        !!(e.end?.date || e.end?.dateTime)),
    "Active Calendar events require start and end",
  );
const monitoringPage = z
  .object({
    items: z.array(monitoringEvent).max(100).default([]),
    nextPageToken: z.string().min(1).max(2000).optional(),
  })
  .passthrough();
/** Google answered with a non-success HTTP status. */
export class GoogleHttpError extends Error {
  constructor(readonly status: number) {
    super(`Google request failed (${status})`);
  }
}
export async function googleJson(r: Response) {
  if (!r.ok) throw new GoogleHttpError(r.status);
  return JSON.parse(new TextDecoder().decode(await boundedBytes(r, 2000000)));
}
/** Google rejected credentials: the owner must reconnect (authorization) or the operator must fix OAuth settings (configuration). */
export class GoogleAuthError extends Error {
  constructor(
    readonly kind: "authorization" | "configuration",
    message: string,
  ) {
    super(message);
  }
}
/** Creation stopped before the insert request was sent, so no event can exist. */
export class CalendarNotSentError extends Error {
  constructor(
    message: string,
    readonly reason: "authorization" | "configuration" | "not_sent",
  ) {
    super(message);
  }
}
/** Reads the OAuth `error` code from a bounded failure body; undefined when absent or unreadable. */
async function oauthErrorCode(r: Response) {
  try {
    const reader = r.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    const code = JSON.parse(text).error;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
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
  if (!c.refreshToken)
    throw new GoogleAuthError(
      "configuration",
      "Google connection is not configured",
    );
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
  if (r.status === 400 || r.status === 401) {
    // Only invalid_grant (expired/revoked refresh token) is fixed by reconnecting; other codes are client settings.
    const code = await oauthErrorCode(r);
    throw code === "invalid_grant"
      ? new GoogleAuthError(
          "authorization",
          "Google authorization expired or was revoked (invalid_grant); reconnect required",
        )
      : new GoogleAuthError(
          "configuration",
          `Google OAuth client is not configured correctly (${code ?? r.status})`,
        );
  }
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
    const response = await this.request(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers, redirect: "error", signal: AbortSignal.timeout(15000) },
    );
    if (response.status === 401 || response.status === 403)
      throw new GoogleAuthError(
        "authorization",
        `Google authorization rejected (${response.status}); reconnect required`,
      );
    const profile = await googleJson(response);
    if (profile.email?.toLowerCase() !== this.c.email.toLowerCase())
      throw new GoogleAuthError("authorization", "Wrong Google account");
    return headers;
  }
  /** sendBy: a performance.now() deadline; past it the insert is not sent. */
  async create(
    user: string,
    approval: string,
    input: CalendarDraft,
    sendBy = Infinity,
  ) {
    let draft: CalendarDraft, headers: Record<string, string>, id: string;
    try {
      draft = validateDraft(input);
      headers = await this.headers(user);
      id = approval.replaceAll("-", "");
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid approval ID");
      if (performance.now() > sendBy)
        throw new Error("Approval attempt window passed before sending");
    } catch (e) {
      throw new CalendarNotSentError(
        e instanceof Error ? e.message : "Calendar request was not sent",
        e instanceof GoogleAuthError ? e.kind : "not_sent",
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
            ...(draft.allDay
              ? {
                  start: { date: draft.start },
                  end: { date: dayAfter(draft.end) },
                }
              : {
                  start: { dateTime: draft.start, timeZone: "Asia/Singapore" },
                  end: { dateTime: draft.end, timeZone: "Asia/Singapore" },
                }),
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
    const id = approval.replaceAll("-", "");
    // A deleted event keeps its ID but may lose its private properties.
    if (result.status === "cancelled" && result.id === id) return result;
    if (result.extendedProperties?.private?.companionApproval !== approval)
      throw new Error("Event identity mismatch");
    return result;
  }
  async list(user: string, start: string, end: string, monitoring = false) {
    if (!this.c.owner || user !== this.c.owner)
      throw new Error("Calendar is not connected for this user");
    const duration = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 31 * 86400000)
      throw new Error("Calendar range must be between 0 and 31 days");
    const headers = await this.headers(user);
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
    let r: any,
      items: any[] = [];
    for (let page = 0; page < (monitoring ? 5 : 1); page++) {
      r = await googleJson(
        await this.request(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        }),
      );
      if (r.items !== undefined && !Array.isArray(r.items))
        throw new Error("Invalid Calendar event collection");
      if (monitoring) r = monitoringPage.parse(r);
      items.push(...(r.items ?? []).slice(0, 100));
      if (!r.nextPageToken) break;
      url.searchParams.set("pageToken", String(r.nextPageToken));
    }
    return {
      untrusted: true,
      calendar: "primary",
      truncated: !!r.nextPageToken,
      events: items.map((e: any) => ({
        id: e.id,
        title: e.summary ?? "(Untitled)",
        start: e.start,
        end: e.end,
        // Google's all-day end date is exclusive; drafts use the inclusive last day.
        lastDay: e.end?.date ? dayBefore(e.end.date) : undefined,
        location: e.location,
        url: e.htmlLink,
        status: e.status,
        ...(monitoring
          ? {
              attendees: (e.attendees ?? []).slice(0, 100).map((a: any) => ({
                email: a.email,
                self: a.self === true,
                resource: a.resource === true,
                responseStatus: a.responseStatus,
              })),
              attendeesOmitted:
                !!e.attendeesOmitted || (e.attendees ?? []).length > 100,
              recurringEventId: e.recurringEventId,
              originalStartTime: e.originalStartTime,
              updated: e.updated,
            }
          : {}),
      })),
    };
  }
}
