import { CronExpressionParser } from "cron-parser";
export class ScheduleParser {
  constructor(private clock: () => Date = () => new Date()) {}
  async next(
    schedule: string,
    saved?: unknown,
  ): Promise<{ parsed: any; next: string | null }> {
    const now = this.clock();
    let parsed: any = saved;
    if (!parsed) {
      const s = schedule.trim().toLowerCase();
      const duration =
        /^(in |every )?(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hours?|d|days?)$/.exec(
          s,
        );
      if (duration) {
        const minutes =
          Number(duration[2]) *
          (duration[3]!.startsWith("h")
            ? 60
            : duration[3]!.startsWith("d")
              ? 1440
              : 1);
        parsed =
          duration[1] === "in "
            ? {
                kind: "once",
                run_at: new Date(now.getTime() + minutes * 60000).toISOString(),
                display: s,
              }
            : { kind: "interval", minutes, display: s };
      } else if (/^\d{4}-\d{2}-\d{2}T/i.test(schedule)) {
        const iso = /([zZ]|[+-]\d\d:\d\d)$/.test(schedule)
          ? schedule
          : schedule + "+08:00";
        parsed = {
          kind: "once",
          run_at: new Date(iso).toISOString(),
          display: schedule,
        };
      } else {
        const natural =
          /^(?:every )?(day|daily|weekdays|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(
            s,
          );
        let expr = s;
        if (natural) {
          let hour = Number(natural[2]);
          const minute = Number(natural[3] ?? 0);
          if (natural[4]) {
            if (hour < 1 || hour > 12) throw new Error("Invalid hour");
            hour = (hour % 12) + (natural[4] === "pm" ? 12 : 0);
          }
          if (hour > 23 || minute > 59) throw new Error("Invalid time");
          const days: Record<string, string> = {
            day: "*",
            daily: "*",
            weekdays: "1-5",
            sunday: "0",
            monday: "1",
            tuesday: "2",
            wednesday: "3",
            thursday: "4",
            friday: "5",
            saturday: "6",
          };
          expr = `${minute} ${hour} * * ${days[natural[1]!]}`;
        }
        parsed = { kind: "cron", expr, display: schedule };
      }
    }
    if (parsed.kind === "once") {
      const next = Date.parse(parsed.run_at);
      if (!Number.isFinite(next)) throw new Error("Invalid once schedule");
      return {
        parsed,
        next: next > now.getTime() ? new Date(next).toISOString() : null,
      };
    }
    if (parsed.kind === "interval") {
      if (!Number.isFinite(parsed.minutes) || parsed.minutes < 60)
        throw new Error("Recurring schedules must be at least hourly");
      return {
        parsed,
        next: new Date(now.getTime() + parsed.minutes * 60000).toISOString(),
      };
    }
    if (
      parsed.kind !== "cron" ||
      typeof parsed.expr !== "string" ||
      parsed.expr.trim().split(/\s+/).length !== 5 ||
      !/^\d{1,2}$/.test(parsed.expr.trim().split(/\s+/)[0]!)
    )
      throw new Error(
        "Use five-field cron with one fixed minute; recurrence must be at least hourly",
      );
    const cron = CronExpressionParser.parse(parsed.expr, {
      currentDate: now,
      tz: "Asia/Singapore",
    });
    const first = cron.next();
    const second = cron.next();
    if (second.getTime() - first.getTime() < 3600000)
      throw new Error("Recurring schedules must be at least hourly");
    return { parsed, next: first.toISOString() };
  }
}
