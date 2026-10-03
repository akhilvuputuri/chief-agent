// Browser entry point: no backend imports, generated HTML, localStorage or credential logging.
export {};
type Block = {
  id: string;
  type: string;
  title: string;
  body?: string;
  columns?: string[];
  rows?: string[][];
  items?: { title: string; body: string; when?: string }[];
  unit?: string;
  points?: { label: string; value: number }[];
};
type Doc = {
  schemaVersion: number;
  title: string;
  summary: string;
  blocks: Block[];
  sources: { label: string; url: string }[];
};
const tg = (window as any).Telegram?.WebApp;
const root = document.getElementById("app")!;
let token = "",
  controller = new AbortController(),
  poll: ReturnType<typeof setInterval> | undefined;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  cls?: string,
) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const btn = (text: string, click: () => void) => {
  const b = el("button", text);
  b.type = "button";
  b.addEventListener("click", click);
  return b;
};
const date = (value: string) =>
  new Date(value).toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " SGT";
async function api(
  path: string,
  signal = controller.signal,
  options: RequestInit = {},
) {
  const r = await fetch("/api/miniapp" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    cache: "no-store",
    signal,
  });
  if (r.status === 401)
    throw new Error(
      "Your session has expired. Close this window and open it again from Telegram.",
    );
  if (!r.ok)
    throw new Error(
      r.status === 404
        ? "This saved view is unavailable."
        : "Could not load this view. Try again shortly.",
    );
  const data = await r.json();
  signal.throwIfAborted();
  return data;
}
function safeLink(label: string, url: string) {
  const a = el("a", label);
  try {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return el("span", label);
    a.href = parsed.href;
  } catch {
    return el("span", label);
  }
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
function go(params: Record<string, string> = {}) {
  const next = "#" + new URLSearchParams(params).toString();
  if (location.hash === next || (!location.hash && next === "#")) void route();
  else location.hash = next;
}
function block(b: Block) {
  const box = el("section", undefined, "block");
  if (b.type === "details") {
    const d = el("details");
    d.append(el("summary", b.title), el("p", b.body, "prose"));
    box.append(d);
    return box;
  }
  box.append(el("h2", b.title));
  if (b.type === "text") box.append(el("p", b.body, "prose"));
  if (b.type === "table") {
    const wrap = el("div", undefined, "table-scroll"),
      t = el("table"),
      head = el("thead"),
      tr = el("tr"),
      body = el("tbody");
    t.setAttribute("aria-label", b.title);
    for (const c of b.columns ?? []) {
      const th = el("th", c);
      th.scope = "col";
      tr.append(th);
    }
    head.append(tr);
    for (const cells of b.rows ?? []) {
      const row = el("tr");
      for (const c of cells) row.append(el("td", c));
      body.append(row);
    }
    t.append(head, body);
    wrap.append(t);
    box.append(wrap);
  }
  if (b.type === "cards" || b.type === "timeline") {
    const list = el(
      "div",
      undefined,
      b.type === "timeline" ? "timeline" : "cards",
    );
    for (const item of b.items ?? []) {
      const card = el(
        "div",
        undefined,
        b.type === "cards" ? "card" : undefined,
      );
      if (item.when) card.append(el("small", item.when));
      card.append(el("h3", item.title), el("p", item.body, "prose"));
      list.append(card);
    }
    box.append(list);
  }
  if (b.type === "chart") {
    const points = b.points ?? [],
      max = Math.max(1, ...points.map((p) => p.value));
    for (const p of points) {
      const row = el("div", undefined, "chart-row"),
        label = el("div", undefined, "chart-label");
      label.append(
        el("span", p.label),
        el("strong", `${p.value.toLocaleString()} ${b.unit ?? ""}`),
      );
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 10");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      rect.setAttribute("width", String((Math.max(0, p.value) / max) * 100));
      rect.setAttribute("height", "10");
      rect.setAttribute("rx", "3");
      svg.append(rect);
      row.append(label, svg);
      box.append(row);
    }
  }
  return box;
}
async function library(roles = false) {
  root.replaceChildren(
    el("div", roles ? "YOUR SAVED ROLES" : "YOUR WORKSPACE", "eyebrow"),
    el("h1", roles ? "Roles" : "Canvases"),
    el(
      "p",
      roles
        ? "Open a role to read its saved details."
        : "Analysis, plans and research you can come back to.",
      "muted",
    ),
  );
  const list = el("div"),
    search = el("input"),
    count = el("p", undefined, "count");
  search.type = "search";
  search.placeholder = roles
    ? "Filter loaded roles…"
    : "Filter loaded canvases…";
  search.setAttribute("aria-label", search.placeholder);
  const cards: { node: HTMLButtonElement; text: string }[] = [];
  let offset: number | null = 0;
  const more = btn("Load more", () => load().catch(showError));
  const filter = () => {
    let n = 0;
    for (const c of cards) {
      c.node.hidden = !c.text.includes(search.value.toLowerCase());
      if (!c.node.hidden) n++;
    }
    count.textContent = `${n} shown · ${cards.length} loaded${offset !== null ? " · more available" : ""}`;
  };
  search.addEventListener("input", filter);
  root.append(search, count, list, more);
  async function load() {
    more.disabled = true;
    try {
      const data = await api(
        (roles ? "/roles" : "/canvases") + "?offset=" + offset,
      );
      for (const item of data.items) {
        const label = roles ? item.company + " — " + item.title : item.title;
        const card = btn("", () =>
          go(roles ? { role: item.id } : { canvas: item.id }),
        );
        card.className = "card link";
        card.append(
          el("strong", label),
          el(
            "small",
            roles
              ? item.status
              : `Revision ${item.latest_revision} · ${date(item.updated_at)}`,
          ),
        );
        list.append(card);
        cards.push({ node: card, text: label.toLowerCase() });
      }
      offset = data.nextOffset;
      more.hidden = offset === null;
      filter();
      if (!cards.length)
        list.append(
          el(
            "p",
            roles
              ? "No saved roles yet."
              : "No canvases yet. Ask the bot to save an analysis or plan as a canvas.",
            "empty",
          ),
        );
    } finally {
      more.disabled = false;
    }
  }
  await load();
}
async function canvas(id: string, revision?: string) {
  const row = await api(
    "/canvases/" +
      encodeURIComponent(id) +
      (revision ? "?revision=" + encodeURIComponent(revision) : ""),
  );
  const d = row.document as Doc;
  if (d.schemaVersion !== 1)
    throw new Error("This canvas needs a newer viewer.");
  const toolbar = el("div", undefined, "toolbar"),
    versions = el("select");
  versions.setAttribute("aria-label", "Canvas revision");
  const latest = el("option", "Latest revision");
  latest.value = "";
  versions.append(latest);
  let historyOffset: number | null = 0;
  const older = btn("Older revisions", () => loadHistory().catch(showError));
  async function loadHistory() {
    older.disabled = true;
    try {
      const history = await api(
        "/canvases/" +
          encodeURIComponent(id) +
          "/history?offset=" +
          historyOffset,
      );
      for (const v of history.items) {
        const option = el(
          "option",
          `Revision ${v.revision} · ${date(v.created_at)}`,
        );
        option.value = String(v.revision);
        versions.append(option);
      }
      historyOffset = history.nextOffset;
      older.hidden = historyOffset === null;
      if (revision) {
        if (!Array.from(versions.options).some((o) => o.value === revision)) {
          const option = el("option", "Revision " + revision);
          option.value = revision;
          versions.append(option);
        }
        versions.value = revision;
      }
    } finally {
      older.disabled = false;
    }
  }
  versions.addEventListener("change", () =>
    go(
      versions.value
        ? { canvas: id, revision: versions.value }
        : { canvas: id },
    ),
  );
  toolbar.append(
    btn("← Canvases", () => go()),
    versions,
    older,
  );
  const notice = el("div", undefined, "version-note"),
    refresh = btn("Open latest revision", () => {
      go({ canvas: id });
      void route();
    });
  refresh.hidden = true;
  notice.append(refresh);
  root.replaceChildren(
    toolbar,
    el("div", "SAVED CANVAS", "eyebrow"),
    el("h1", d.title),
    el("p", d.summary, "prose"),
    el(
      "p",
      `Revision ${row.revision} · Saved ${date(row.created_at)}`,
      "muted",
    ),
    notice,
  );
  if (row.revision < row.latest_revision) refresh.hidden = false;
  for (const b of d.blocks) root.append(block(b));
  if (d.sources.length) {
    const sources = el("section", undefined, "block");
    sources.append(el("h2", "Sources"));
    for (const s of d.sources) {
      const p = el("p");
      p.append(safeLink(s.label, s.url));
      sources.append(p);
    }
    root.append(sources);
  }
  await loadHistory();
  const signal = controller.signal;
  poll = setInterval(() => {
    if (document.hidden) return;
    void api("/canvases/" + encodeURIComponent(id) + "/head", signal)
      .then((head) => {
        if (head.latest_revision > row.revision) refresh.hidden = false;
      })
      .catch(() => {});
  }, 20000);
}
async function role(id: string) {
  const r = await api("/roles/" + encodeURIComponent(id));
  root.replaceChildren(
    btn("← Roles", () => go({ view: "roles" })),
    el("p", r.company, "eyebrow"),
    el("h1", r.title),
    el("p", r.status + " · Updated " + date(r.updated_at), "muted"),
  );
  if (r.url) {
    const p = el("p");
    p.append(safeLink("Original listing ↗", r.url));
    root.append(p);
  }
  for (const [title, body] of [
    ["Description", r.description],
    ["Saved notes", r.notes],
  ])
    if (body) {
      const section = el("section", undefined, "block");
      section.append(el("h2", title), el("p", body, "prose"));
      root.append(section);
    }
}
const subscriptionPrice = (r: any) =>
  r.amount == null
    ? `Amount unknown · ${r.cadence} · ${r.amountType}`
    : `${r.amount} ${r.currency} · ${r.cadence === "days" ? `every ${r.intervalDays} days` : r.cadence} · ${r.amountType}`;
async function subscriptions(id?: string) {
  if (id) {
    const r = await api("/subscriptions/" + encodeURIComponent(id));
    root.replaceChildren(
      btn("← Subscriptions", () => go({ view: "subscriptions" })),
      el("div", "SAVED SUBSCRIPTION", "eyebrow"),
      el("h1", r.label),
      el("p", subscriptionPrice(r), "prose"),
      el("p", `${r.status} · Owner stated · Updated ${date(r.asOf)}`, "muted"),
      el("p", r.notice, "muted"),
    );
    const details = el("section", undefined, "block");
    details.append(el("h2", "Plan and dates"));
    for (const [label, value] of [
      ["Merchant", r.merchant],
      ["Plan", r.plan],
      ["Account label", r.accountLabel],
      [
        "Next charge",
        r.nextChargeDate
          ? r.nextChargeDate +
            (r.nextChargeEstimated ? " (estimated)" : " (saved date)")
          : "Unknown",
      ],
      ["Trial ends", r.trialEndDate ?? "Unknown"],
      ["Cancellation deadline", r.cancellationDeadline ?? "Unknown"],
      ["Paid through", r.paidThroughDate ?? "Unknown"],
      [
        "Monthly equivalent",
        r.monthlyEquivalent == null
          ? "Excluded from fixed monthly total"
          : `${r.monthlyEquivalent} ${r.currency} (estimate)`,
      ],
    ])
      if (value) details.append(el("p", `${label}: ${value}`));
    root.append(details);
    const reminders = el("section", undefined, "block");
    reminders.append(
      el("h2", "Reminders"),
      el("p", r.reminderEnabled ? "Enabled for saved dates" : "Off"),
    );
    for (const reminder of r.reminders)
      reminders.append(
        el(
          "p",
          `${reminder.date}: ${date(reminder.firesat ?? reminder.firesAt)} · ${reminder.status}${reminder.last_error ? " · " + reminder.last_error : ""}`,
        ),
      );
    root.append(reminders);
    const history = el("section", undefined, "block");
    history.append(el("h2", "History"));
    let offset: number | null = 0;
    const more = btn("Older updates", () => loadHistory().catch(showError));
    async function loadHistory() {
      more.disabled = true;
      try {
        const page =
          offset === 0
            ? r
            : await api(
                "/subscriptions/" +
                  encodeURIComponent(id!) +
                  "?offset=" +
                  offset,
              );
        for (const update of page.history) {
          const entry = el("div", undefined, "card");
          entry.append(
            el(
              "strong",
              `Revision ${update.revision} · ${date(update.recorded_at)}`,
            ),
          );
          for (const [key, value] of Object.entries(update.changes))
            entry.append(
              el(
                "p",
                `${key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}: ${value === null ? "cleared" : String(value)}`,
              ),
            );
          entry.append(el("small", "Source: owner statement"));
          history.append(entry);
        }
        offset = page.nextOffset;
        more.hidden = offset === null;
      } finally {
        more.disabled = false;
      }
    }
    root.append(history, more);
    await loadHistory();
    return;
  }
  const data = await api("/subscriptions");
  root.replaceChildren(
    el("div", "YOUR RECURRING PAYMENTS", "eyebrow"),
    el("h1", "Subscriptions"),
    el("p", data.notice, "muted"),
  );
  const totals = el("section", undefined, "block");
  totals.append(el("h2", "Fixed monthly equivalents"));
  for (const total of data.totals)
    totals.append(
      el(
        "p",
        `${total.monthlyEquivalent} ${total.currency} · ${total.items} active items`,
      ),
    );
  totals.append(
    el(
      "p",
      `${data.excluded} items with trial, variable or unknown costs excluded.`,
      "muted",
    ),
    el("p", data.basis, "muted"),
  );
  root.append(totals);
  const timeline = el("section", undefined, "block");
  timeline.append(el("h2", "Next 30 days"));
  for (const due of data.upcoming) {
    const row = btn(
      `${due.date} · ${due.label} · ${due.events.join(" / ")}${due.estimated ? " (estimated)" : ""}`,
      () => go({ subscription: due.id }),
    );
    row.className = "card link";
    timeline.append(row);
  }
  if (!data.upcoming.length)
    timeline.append(el("p", "No upcoming saved dates.", "muted"));
  if (data.upcomingTotal > data.upcoming.length)
    timeline.append(
      el(
        "p",
        `Showing ${data.upcoming.length} of ${data.upcomingTotal} dates. Open an item for its dates.`,
      ),
    );
  root.append(timeline);
  const list = el("section", undefined, "block");
  list.append(el("h2", "Saved items"));
  root.append(list);
  let offset: number | null = 0;
  const more = btn("Load more", () => load().catch(showError));
  async function load() {
    more.disabled = true;
    try {
      const page =
        offset === 0 ? data : await api("/subscriptions?offset=" + offset);
      for (const item of page.items) {
        const card = btn("", () => go({ subscription: item.id }));
        card.className = "card link";
        card.append(
          el("strong", item.label),
          el("small", `${subscriptionPrice(item)} · ${item.status}`),
        );
        list.append(card);
      }
      offset = page.nextOffset;
      more.hidden = offset === null;
      if (!page.total)
        list.append(
          el(
            "p",
            "No saved subscriptions yet. Tell Chief which recurring payment to track.",
            "empty",
          ),
        );
    } finally {
      more.disabled = false;
    }
  }
  root.append(
    more,
    el(
      "p",
      "Add items and change reminders by talking to Chief in Telegram.",
      "muted",
    ),
  );
  await load();
}
function showError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  root.replaceChildren(
    el(
      "p",
      error instanceof Error ? error.message : "Could not load this view.",
      "error",
    ),
    btn("Try again", () => void route()),
  );
}
async function responsibilities(id?: string, offset = 0) {
  const rows = id
    ? [
        await api(
          "/responsibilities/" + encodeURIComponent(id) + "?offset=" + offset,
        ),
      ]
    : await api("/responsibilities?offset=" + offset);
  root.replaceChildren(
    el("h1", id ? "Monitoring history" : "Responsibilities"),
  );
  if (id)
    root.append(
      btn("← Responsibilities", () => go({ view: "responsibilities" })),
    );
  if (!rows.length)
    root.append(
      el(
        "p",
        "No responsibilities yet. Ask Chief in Telegram to watch a concern.",
        "empty",
      ),
    );
  for (const entry of rows) {
    const r = id ? entry.responsibility : entry;
    const section = el("section", undefined, "block");
    section.append(
      el("h2", r.spec.title),
      el("p", r.status + (r.degraded ? " · source degraded" : ""), "muted"),
      el("p", r.spec.outcome),
      el("p", r.understanding || "No finding yet."),
    );
    section.append(
      el(
        "p",
        `Last check: ${r.last_check ? date(r.last_check) : "not yet"} · Next: ${r.next_check ? date(r.next_check) : "none"} · Investigations today: ${r.investigations_today ?? 0}/6`,
        "muted",
      ),
    );
    if (!id)
      section.append(
        btn("History", () =>
          go({ view: "responsibilities", responsibility: r.id }),
        ),
      );
    else {
      for (const f of entry.findings) {
        const block = el("section", undefined, "block");
        block.append(
          el("h3", `${f.decision} · ${f.reason} · revision ${f.revision}`),
          el("p", f.payload.reply, "prose"),
          el("p", `Delivery: ${f.state} · ${date(f.created_at)}`, "muted"),
        );
        section.append(block);
      }
      for (const c of entry.checks)
        section.append(
          el(
            "p",
            `Check: ${c.outcome} · ${c.candidates} new candidates · ${date(c.created_at)}`,
            "muted",
          ),
        );
      for (const i of entry.investigations)
        section.append(
          el(
            "p",
            `Investigation: ${i.status}${i.pause_reason ? " (" + i.pause_reason + ")" : ""} · ${i.used_models} model / ${i.used_tools} tool calls · ${i.used_ms} ms · Reported USD ${i.reported_cost ?? "unavailable"}; estimated unreported USD ${i.estimated_unknown_cost ?? "unavailable"}`,
            "muted",
          ),
        );
      if (offset > 0)
        section.append(
          btn("Newer history", () =>
            go({
              view: "responsibilities",
              responsibility: id,
              offset: String(Math.max(0, offset - 10)),
            }),
          ),
        );
      if (entry.nextOffset !== null)
        section.append(
          btn("Older history", () =>
            go({
              view: "responsibilities",
              responsibility: id,
              offset: String(entry.nextOffset),
            }),
          ),
        );
    }
    root.append(section);
  }
  if (!id) {
    if (offset > 0)
      root.append(
        btn("Newer concerns", () =>
          go({
            view: "responsibilities",
            offset: String(Math.max(0, offset - 50)),
          }),
        ),
      );
    if (rows.length === 50)
      root.append(
        btn("Older concerns", () =>
          go({ view: "responsibilities", offset: String(offset + 50) }),
        ),
      );
  }
}
async function downloadFile(path: string, name: string) {
  const response = await fetch("/api/miniapp" + path, {
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
    signal: controller.signal,
  });
  if (!response.ok)
    throw new Error("This file could not be retrieved. Reopen the workspace.");
  const blob = await response.blob();
  controller.signal.throwIfAborted();
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function gathering(id?: string, offset = 0) {
  root.replaceChildren(
    el("h1", id ? "Invoice collection" : "Invoice collections"),
  );
  const data = await api(
    id ? "/gathering/" + id : "/gathering?offset=" + offset,
  );
  if (!id) {
    const profiles = await api("/browser-profiles").catch(() => []);
    for (const profile of profiles) {
      const forget = btn(
        `Forget saved login: ${profile.origin} · ${profile.account_label}`,
        () => {
          forget.disabled = true;
          root.append(
            btn("Confirm forget login and close its browsers", () => {
              void api("/browser-profiles/forget", controller.signal, {
                method: "POST",
                body: JSON.stringify({
                  origin: profile.origin,
                  accountLabel: profile.account_label,
                  confirmed: true,
                }),
              })
                .then(() => gathering())
                .catch(showError);
            }),
          );
        },
      );
      root.append(forget);
    }
    for (const c of data.collections) {
      const card = btn("", () => go({ view: "gathering", gather: c.id }));
      card.className = "card link";
      card.append(
        el("strong", c.objective),
        el("small", `${c.state} · task ${c.task_status}`),
      );
      root.append(card);
    }
    if (!data.collections.length)
      root.append(
        el(
          "p",
          "Tell Chief which providers, accounts and invoice months to gather.",
          "empty",
        ),
      );
    if (data.nextOffset !== null)
      root.append(
        btn("Older collections", () =>
          go({ view: "gathering", offset: String(data.nextOffset) }),
        ),
      );
    return;
  }
  root.append(
    el("p", data.objective, "prose"),
    el(
      "p",
      `${data.counts.covered} of ${data.counts.expected} targets checked · ${data.counts.files} matched PDFs · ${data.state}`,
    ),
    el("p", data.notice, "muted"),
  );
  const archive = btn("Download matched PDFs as ZIP", () =>
    downloadFile(
      "/gathering/" + id + "/archive",
      "invoices-" + id.slice(0, 8) + ".zip",
    ).catch(showError),
  );
  archive.disabled = !data.counts.files;
  root.append(archive);
  for (const target of data.targets) {
    const box = el("section", undefined, "block");
    box.append(
      el("h2", `${target.label} · ${target.month}`),
      el(
        "p",
        `${target.accountLabel ?? "Selected account"} · ${target.dateBasis === "service_period" ? "Billed service period" : "Invoice issue month"} · ${target.state}`,
      ),
    );
    if (target.reason)
      box.append(el("p", String(target.reason).replace(/_/g, " "), "muted"));
    if (target.coverage_note)
      box.append(el("p", target.coverage_note, "muted"));
    for (const file of target.files)
      box.append(
        btn(`Download matched invoice · ${file.date}`, () =>
          downloadFile("/files/" + file.artifact_id, file.name).catch(
            showError,
          ),
        ),
      );
    for (const candidate of target.candidates.filter(
      (c: any) =>
        !target.files.some((f: any) => f.artifact_id === c.artifact_id),
    )) {
      box.append(
        el(
          "p",
          `${candidate.facts.invoiceNumbers?.[0] ?? candidate.name} · ${candidate.facts.invoiceDates?.join(", ") || "Date unverified"}`,
          "muted",
        ),
      );
      if (target.accountLabel && candidate.account_verified)
        box.append(
          el("p", `Account verified by you: ${target.accountLabel}`, "muted"),
        );
      box.append(
        btn("Download unverified candidate PDF", () =>
          downloadFile("/files/" + candidate.artifact_id, candidate.name).catch(
            showError,
          ),
        ),
      );
      if (
        target.accountLabel &&
        !candidate.account_verified &&
        !["complete", "cancelled"].includes(data.state)
      ) {
        const verify = btn(
          `Verify account for this PDF: ${target.accountLabel}`,
          () => {
            verify.disabled = true;
            const confirm = btn(
              `I inspected this PDF: it belongs to ${target.accountLabel}`,
              () => {
                confirm.disabled = true;
                void api("/gathering/" + id + "/account", controller.signal, {
                  method: "POST",
                  body: JSON.stringify({
                    targetKey: target.key,
                    artifactId: candidate.artifact_id,
                    revision: data.revision,
                    confirmed: true,
                  }),
                })
                  .then(() => gathering(id))
                  .catch(showError);
              },
            );
            box.append(
              el(
                "p",
                `Download and inspect the PDF above. Confirm its provider account is ${target.accountLabel} for ${target.label}, ${target.month}. This does not confirm coverage.`,
              ),
              confirm,
            );
          },
        );
        box.append(verify);
      }
    }
    for (const browser of data.browsers.filter(
      (b: any) => b.target_key === target.key && b.state === "owner",
    ))
      box.append(
        btn("Sign in and review invoice history", () =>
          go({ view: "gathering", browser: browser.id }),
        ),
      );
    root.append(box);
  }
  if (!["complete", "cancelled"].includes(data.state))
    root.append(
      el(
        "p",
        `Task: ${data.taskId}. Resolve blockers, then explicitly continue in Telegram with /continue ${data.taskId}.`,
        "muted",
      ),
    );
  root.append(btn("Refresh collection", () => void route()));
}
async function route() {
  controller.abort();
  controller = new AbortController();
  if (poll) clearInterval(poll);
  poll = undefined;
  const p = new URLSearchParams(location.hash.slice(1));
  const gatheringView =
    p.has("gather") || p.has("browser") || p.get("view") === "gathering";
  const privacyFooter = document.querySelector("footer");
  if (privacyFooter)
    privacyFooter.textContent = gatheringView
      ? "Private workspace · Only you verify accounts and control sign-in."
      : "Private workspace · Changes and approvals stay in Telegram";
  document
    .getElementById("gathering")
    ?.classList.toggle("selected", gatheringView);
  const subscriptionsView =
    p.has("subscription") || p.get("view") === "subscriptions";
  document
    .getElementById("subscriptions")!
    .classList.toggle("selected", subscriptionsView);
  document
    .getElementById("roles")!
    .classList.toggle("selected", p.has("role") || p.get("view") === "roles");
  document
    .getElementById("canvases")!
    .classList.toggle(
      "selected",
      !subscriptionsView &&
        !gatheringView &&
        !p.has("role") &&
        !["roles", "responsibilities"].includes(p.get("view") ?? ""),
    );
  document
    .getElementById("responsibilities")!
    .classList.toggle("selected", p.get("view") === "responsibilities");
  try {
    if (p.has("browser")) {
      const { browserView } = await import("./browser-ui.js");
      await browserView(root, token, p.get("browser")!, controller.signal);
    } else if (gatheringView)
      await gathering(
        p.get("gather") ?? undefined,
        Number(p.get("offset") ?? 0),
      );
    else if (subscriptionsView)
      await subscriptions(p.get("subscription") ?? undefined);
    else if (p.get("view") === "responsibilities")
      await responsibilities(
        p.get("responsibility") ?? undefined,
        Number(p.get("offset") ?? 0),
      );
    else if (p.has("canvas"))
      await canvas(p.get("canvas")!, p.get("revision") ?? undefined);
    else if (p.has("role")) await role(p.get("role")!);
    else await library(p.get("view") === "roles");
  } catch (e) {
    showError(e);
  }
}
async function start() {
  document
    .getElementById("gathering")
    ?.addEventListener("click", () => go({ view: "gathering" }));
  document
    .getElementById("subscriptions")!
    .addEventListener("click", () => go({ view: "subscriptions" }));
  document
    .getElementById("responsibilities")
    ?.addEventListener("click", () => go({ view: "responsibilities" }));
  document.getElementById("canvases")!.addEventListener("click", () => go());
  document
    .getElementById("roles")!
    .addEventListener("click", () => go({ view: "roles" }));
  if (!tg?.initData) {
    root.replaceChildren(
      el("h1", "Your private workspace"),
      el(
        "p",
        "Open this view using the Canvases button in your Telegram bot.",
        "empty",
      ),
    );
    return;
  }
  tg.ready();
  tg.expand();
  const response = await fetch("/api/miniapp/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: tg.initData }),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      "This Telegram session could not be verified. Close this window and open it again from the bot.",
    );
  token = (await response.json()).token;
  const capabilities = await api("/capabilities");
  document.getElementById("responsibilities")!.hidden =
    !capabilities.responsibilities;
  document.getElementById("gathering")!.hidden = !capabilities.gathering;
  // Telegram's launch fragment is parsed by the SDK; never retain signed data in our navigation URLs.
  const query = new URLSearchParams(location.search);
  const initial = new URLSearchParams();
  for (const key of [
    "canvas",
    "revision",
    "view",
    "subscription",
    "responsibility",
    "gather",
    "browser",
  ])
    if (query.has(key)) initial.set(key, query.get(key)!);
  history.replaceState(null, "", "/miniapp/#" + initial.toString());
  addEventListener("hashchange", () => void route());
  await route();
}
void start().catch(showError);
