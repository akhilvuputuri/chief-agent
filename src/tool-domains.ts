// Relevant tool loading (issue #77 stage 2). The coordinator model is offered a
// compact core plus the capability domains a request needs; tools_load adds
// more during a turn. Offering a schema never grants permission: the
// owner-scoped dispatcher and availability checks stay authoritative.

/** Offered on every coordinator call. */
export const CORE_OPERATIONS = new Set([
  "feed_read",
  "conversation_search",
  "conversation_read",
  "observation_read",
  "source_read",
  "memory_set",
  "memory_list",
  "web_search",
  "web_read",
  "skill_list",
  "skill_read",
  "work_status",
  "tools_load",
  "agent_run",
]);

export const TOOL_DOMAINS = [
  "gmail",
  "calendar",
  "daily",
  "jobs",
  "work",
  "research",
  "media",
  "canvas",
  "parcels",
  "library",
  "watchlist",
  "news",
  "routines",
  "responsibilities",
  "skills",
] as const;
export type ToolDomain = (typeof TOOL_DOMAINS)[number];

/** One line per domain for the model's catalogue of loadable tools. */
export const DOMAIN_SUMMARIES: Record<ToolDomain, string> = {
  gmail: "read-only Gmail search/thread/read across connected accounts",
  calendar: "Calendar lookups and approval-gated event drafts",
  daily: "saved items, reminders, briefings and the daily Sheet",
  jobs: "saved roles, analysis, alignment scopes, preparation and its Sheet",
  work: "durable background jobs: start, revise, record steps, yield, cancel",
  research: "isolated public-research specialist and plugin agents",
  media: "specialist reading of attached images and stored documents",
  canvas: "saved Mini App canvases: create, update, read, list",
  parcels: "awaited parcels from email or the owner",
  library: "NLB ebook availability and the linked card's shelf",
  watchlist: "stock price-drop watchlist",
  news: "daily news bulletin from followed sites, topics and 👍/👎 learning",
  routines: "scheduled independent agent routines",
  responsibilities:
    "owner-confirmed ongoing concerns, changes, attention and monitoring history",
  skills: "skill version history, drafts, evaluation and activation",
};

const PREFIXES: [string, ToolDomain][] = [
  ["gmail_", "gmail"],
  ["calendar_", "calendar"],
  ["item_", "daily"],
  ["schedule_", "daily"],
  ["daily_", "daily"],
  ["job_", "jobs"],
  ["prep_", "jobs"],
  ["sheet_", "jobs"],
  ["work_", "work"],
  ["research_", "research"],
  ["agent_", "research"],
  ["media_", "media"],
  ["canvas_", "canvas"],
  ["parcel_", "parcels"],
  ["library_", "library"],
  ["watchlist_", "watchlist"],
  ["news_", "news"],
  ["routine_", "routines"],
  ["responsibility_", "responsibilities"],
  ["skill_", "skills"],
];

/** The domain an operation belongs to; undefined for core operations. */
export function domainOf(operation: string): ToolDomain | undefined {
  if (CORE_OPERATIONS.has(operation)) return undefined;
  return PREFIXES.find(([prefix]) => operation.startsWith(prefix))?.[1];
}

// Conservative cues: a missed domain costs one tools_load step, an extra one
// costs only schema characters. Word boundaries avoid matching inside words.
const CUES: [ToolDomain, RegExp][] = [
  [
    "responsibilities",
    /\b(watch|monitor|keep an eye|keep watching|responsibilit(y|ies)|only (tell|notify)|when .* arrives|until .* (arrive|done|resolved))\b/i,
  ],
  [
    "gmail",
    /\b(e-?mails?|mails?|inbox|gmail|senders?|newsletters?|unread|messages? from|new messages|repl(y|ies|ied)|threads?)\b/i,
  ],
  [
    "calendar",
    /\b(calendar|meetings?|events?|appointments?|agenda|today|tonight|tomorrow|yesterday|this week|next week|(mon|tues|wednes|thurs|fri|satur|sun)days?|free time|busy|availability|dentist|doctor|(lunch|dinner|breakfast|coffee|call) with|\d{1,2}(:\d{2})? ?(am|pm)|on the \d{1,2}(st|nd|rd|th))\b/i,
  ],
  [
    "daily",
    /\b(remind(er|ers)?|to-?dos?|notes?|checklist|briefing|daily sheet|schedules?)\b/i,
  ],
  [
    "jobs",
    /\b(jobs?|roles?|positions?|applications?|apply|interviews?|companies|company|résumé|resume|cv|postings?|recruiter|hiring|prep(aration)?|alignment)\b/i,
  ],
  [
    "work",
    /\b(background|continue|resume|keep going|keep working|pause|cancel|long task|work on it|step by step)\b/i,
  ],
  [
    "research",
    /\b(research|investigate|deep dive|compare sources|find sources|literature)\b/i,
  ],
  [
    "media",
    /\[Attached (image|PDF)|\b(photo|picture|image|screenshot|pdf|document|scan)s?\b/i,
  ],
  ["canvas", /\b(canvas(es)?|mini ?app|save (this|it) as)\b/i],
  [
    "parcels",
    /\b(parcels?|packages?|deliver\w*|shipments?|shipping|tracking|couriers?|order(ed|s)?|dhl|fedex|ups|ninja ?van|j&t|shopee|lazada)\b/i,
  ],
  ["library", /\b(library|libby|nlb|e-?books?|books?|borrow|holds?|loans?)\b/i],
  [
    "watchlist",
    /\b(stocks?|shares?|ticker|watchlist|nasdaq|nyse|sgx|price drop|market)\b/i,
  ],
  [
    "news",
    /\b(news|bulletin|headlines?|digest|blogs?|articles?|substack|feeds?|reading picks?)\b/i,
  ],
  [
    "routines",
    /\b(routines?|every (day|morning|evening|week|hour)|recurring|daily at|cron)\b/i,
  ],
  [
    "skills",
    /\b(skills? (version|history|draft)|draft (a )?skill|activate skill|roll ?back)\b/i,
  ],
];

export interface DomainSignals {
  message: string;
  /** Background job lane or a turn bound to a tracked task. */
  taskBound?: boolean;
  /** Operations used recently by this owner or by the bound task. */
  recentOperations?: Iterable<string>;
  pendingCalendarApproval?: boolean;
  pendingLibraryApproval?: boolean;
}

/** Deterministic initial domain selection from host-visible signals. */
export function selectDomains(signals: DomainSignals): Set<ToolDomain> {
  const selected = new Set<ToolDomain>();
  for (const [domain, cue] of CUES)
    if (cue.test(signals.message)) selected.add(domain);
  if (signals.taskBound) selected.add("work");
  if (signals.pendingCalendarApproval) selected.add("calendar");
  if (signals.pendingLibraryApproval) selected.add("library");
  for (const op of signals.recentOperations ?? []) {
    const domain = domainOf(op);
    if (domain) selected.add(domain);
  }
  return selected;
}
