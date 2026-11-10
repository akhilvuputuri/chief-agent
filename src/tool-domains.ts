// Relevant tool loading (issue #77 stage 2). The coordinator model is offered a
// compact core plus the capability domains a request needs; tools_load adds
// more during a turn. Offering a schema never grants permission: the
// owner-scoped dispatcher and availability checks stay authoritative.

/** Offered on every coordinator call. */
export const CORE_OPERATIONS = new Set([
  "link_resolve",
  "feed_read",
  "conversation_search",
  "memory_recall",
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
  "coding_status",
  "gather_status",
  "tools_load",
  "agent_run",
]);

export const TOOL_DOMAINS = [
  "mcp",
  "links",
  "gmail",
  "calendar",
  "daily",
  "jobs",
  "work",
  "coding",
  "research",
  "media",
  "canvas",
  "subscriptions",
  "gathering",
  "parcels",
  "library",
  "watchlist",
  "news",
  "singapore",
  "routines",
  "responsibilities",
  "skills",
] as const;
export type ToolDomain = (typeof TOOL_DOMAINS)[number];

/** One line per domain for the model's catalogue of loadable tools. */
export const DOMAIN_SUMMARIES: Record<ToolDomain, string> = {
  mcp: "connected remote MCP tools, sourced brief saving and Reader submission status",
  links:
    "the owner's study list for study material: classify a shared link, add, list, filter, update, move, remove",
  gmail: "read-only Gmail search/thread/read across connected accounts",
  calendar: "Calendar lookups and approval-gated event drafts",
  daily: "saved items, reminders, briefings and the daily Sheet",
  jobs: "saved roles, analysis, alignment scopes, preparation and its Sheet",
  work: "durable background tasks: start, revise, steps, evidence, yield, cancel",
  coding:
    "coding sandbox jobs on the owner's repository: start, reply, resume, update, cancel, models",
  research: "isolated public-research specialist and plugin agents",
  media: "specialist reading of attached images and stored documents",
  canvas: "saved Mini App canvases: create, update, read, list",
  subscriptions:
    "saved recurring payments, trial ends, decision dates and reminders",
  gathering:
    "durable invoice collections, scoped source gathering, private PDF files and browser login handoff",
  parcels: "awaited parcels from email or the owner",
  library: "NLB ebook availability and the linked card's shelf",
  watchlist: "stock price-drop watchlist and read-only IBKR holdings",
  news: "daily news bulletin from followed sites, topics and learning from Reader saves",
  singapore:
    "Singapore weather, haze, flood and lightning alerts, carparks, cameras, holidays, hawker closures, bus arrivals, MRT status and traffic",
  routines: "scheduled independent agent routines",
  responsibilities:
    "owner-confirmed ongoing concerns, changes, attention and monitoring history",
  skills: "skill version history, drafts, evaluation and activation",
};

/**
 * Coordinator guidance that matters only when a domain's tools are offered. It travels in the
 * per-call runtime context instead of the fixed instructions, so turns without the domain do
 * not carry it, and a mid-turn load (tools_load or an auto-loaded call) adds it at the end of
 * the request instead of changing the cached prefix.
 */
export const DOMAIN_GUIDANCE: Partial<Record<ToolDomain, string>> = {
  links:
    'When the study-list tools are offered, a shared link is classified before anything is saved: call link_save with the owner\'s own words in ownerMessage. Never default to Reader; Reader is only for offline reading. A confident save goes straight through — say where it went in one line so the owner can correct it ("no, move it to Reader" is link_move; "add it to Reader too" keeps the study entry, so that is link_save, not a move). A needs_choice result means the three tap buttons were sent; do not ask an open question instead. Titles and topics come from the page, never invented. study_list returns phone-friendly text plus entries with the ids study_update, link_move and study_remove need.',
  canvas:
    "When canvas tools are available, use saved canvases for rich results worth revisiting (tables of roles, evidence-backed analyses, preparation plans). Choose useful components based on the request; short conversation stays in Telegram. canvas_list finds earlier documents; canvas_read retrieves exact revisions in chunks. Refining the same topic updates that canvas; a new topic creates a separate canvas. Updates must reconcile the latest base revision and preserve block IDs. A saved canvas is a snapshot, not an independently verified finding. Ground content in actual records/sources; do not invent URLs or data. Use finish_turn.canvases with saved IDs and optional exact revisions to attach open buttons. The Mini App never authorizes sensitive actions. Do not promise a canvas or link before a successful save.",
  jobs: "For job fit, interview research and preparation, use the job-alignment skill and job_alignment_start/resume/read. The scope can be selected roles or all saved roles, never force a one-role workflow. Get exact role IDs from the jobs agent (its refs) or allSaved, and select relevant memory keys. For substantial work establish durable work tracking. Automatically resume pending roles within the existing allocation, keeping scopeId in the task checkpoint; do not restart the scope on each pass. Read full reports before synthesis and requested prep/Sheet saves. Combine overlapping preparation while retaining role/evidence links. Scope history is context, not authorization to resume old work. Reports distinguish unknown experience and interview uncertainty; do not upgrade those to gaps or confirmed stages.",
  work: "Reuse successful research for the current task; do not repeat identical searches. Read a promising original page before searching for more snippets. If a quote is rejected, inspect the source and correct the quote rather than repeating the same claim. Stop discovery when enough evidence supports an answer or a clear limitation. Reserve remaining work for synthesis and recording outcomes. Work in small batches and persist useful findings, evidence and completed steps before collecting many more sources. Older tool observations can leave the bounded context; do not defer all assessment and saving until after exhaustive browsing. For each researched target use an evidence step; writes/exports use action steps with expectedOperation. Use web_read sourceId for work_evidence, observationId for observation_read, and receiptId for execution proofs; these IDs are not interchangeable. Successful tools return receiptId; use those and matched evidence IDs as proofs. Analysis is synthesis, not proof of a write.",
};

const PREFIXES: [string, ToolDomain][] = [
  ["mcp_", "mcp"],
  ["study_", "links"],
  ["link_", "links"],
  ["gmail_", "gmail"],
  ["calendar_", "calendar"],
  ["item_", "daily"],
  ["schedule_", "daily"],
  ["daily_", "daily"],
  ["job_", "jobs"],
  ["prep_", "jobs"],
  ["sheet_", "jobs"],
  ["work_", "work"],
  ["coding_", "coding"],
  ["research_", "research"],
  ["agent_", "research"],
  ["public_browser", "research"],
  ["media_", "media"],
  ["canvas_", "canvas"],
  ["subscription_", "subscriptions"],
  ["gather_", "gathering"],
  ["parcel_", "parcels"],
  ["library_", "library"],
  ["watchlist_", "watchlist"],
  ["portfolio_", "watchlist"],
  ["stock_", "watchlist"],
  ["news_", "news"],
  ["sg_", "singapore"],
  ["lta_", "singapore"],
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
    "links",
    // A shared link is classified before it is saved, so a bare "save this <url>" belongs
    // here too; "save the brief" and Reader status questions stay with mcp below.
    /\b(study (list|material)|for (my )?ai learning|to study|offline reading|read later|tutorials?|(save|keep)\s+(this|that|it)\b[\s\S]{0,120}https?:\/\/|(save|add|move|remove).{0,40}(link|thread|tutorial|study list|reader))\b/i,
  ],
  [
    "mcp",
    /\b(mcp|reader|offline|read later|save.{0,40}(article|brief|link))\b/i,
  ],
  [
    "gathering",
    /\b(gather|collect|download|retrieve|find).{0,70}\b(invoices?|receipts?|billing documents?)\b|\b(invoice collection|billing portal|browser login|gathering task)\b|\[Attached invoice PDF/i,
  ],
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
    "coding",
    /\b(coding|sandbox|pull requests?|prd|repo(sitory)?|code ?base|fix.*bug|implement.*feature)\b|\b(open|create|raise|make)\b.{0,20}\bprs?\b/i,
  ],
  [
    "research",
    /\b(research|investigate|deep dive|compare sources|find sources|literature)\b/i,
  ],
  [
    "media",
    /\[Attached (image|PDF)|\b(photo|picture|image|screenshot|pdf|document|scan)s?\b/i,
  ],
  [
    "subscriptions",
    /\b(subscriptions?|memberships?|renewals?|recurring payments?|bills?|trial ends?|cancel(lation)? deadline|netflix|spotify)\b/i,
  ],
  ["canvas", /\b(canvas(es)?|mini ?app|save (this|it) as)\b/i],
  [
    "parcels",
    /\b(parcels?|packages?|deliver\w*|shipments?|shipping|tracking|couriers?|order(ed|s)?|dhl|fedex|ups|ninja ?van|j&t|shopee|lazada)\b/i,
  ],
  ["library", /\b(library|libby|nlb|e-?books?|books?|borrow|holds?|loans?)\b/i],
  [
    "watchlist",
    /\b(stocks?|shares?|ticker|watchlist|nasdaq|nyse|sgx|price drop|market|portfolio|holdings?|positions?|ibkr|interactive brokers|brokerage)\b/i,
  ],
  [
    "news",
    /\b(news|bulletin|headlines?|digest|blogs?|articles?|substack|feeds?|reading picks?)\b/i,
  ],
  [
    "singapore",
    /\b(weather|rain(ing|y)?|forecast|thunder\w*|showers?|haze|psi|pm ?2\.?5|air quality|uv|heat stress|humid\w*|flood\w*|lightning|car ?parks?|parking|speed cameras?|red.?light cameras?|public holidays?|long weekend|hawker|food centre|bus(es)?|bus stop|mrt|lrt|train (delay|disruption|breakdown)s?|traffic|expressway)\b/i,
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
  /** A coding job of this owner waits on them (plan, question, pause or merge card). */
  pendingCoding?: boolean;
  pendingLibraryApproval?: boolean;
}

/** Deterministic initial domain selection from host-visible signals. */
export function selectDomains(signals: DomainSignals): Set<ToolDomain> {
  const selected = new Set<ToolDomain>();
  for (const [domain, cue] of CUES)
    if (cue.test(signals.message)) selected.add(domain);
  if (signals.taskBound) selected.add("work");
  if (signals.pendingCalendarApproval) selected.add("calendar");
  if (signals.pendingCoding) selected.add("coding");
  if (signals.pendingLibraryApproval) selected.add("library");
  for (const op of signals.recentOperations ?? []) {
    const domain = domainOf(op);
    if (domain) selected.add(domain);
  }
  return selected;
}
