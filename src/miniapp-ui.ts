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
async function api(path: string, signal = controller.signal) {
  const r = await fetch("/api/miniapp" + path, {
    headers: { Authorization: "Bearer " + token },
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
async function route() {
  controller.abort();
  controller = new AbortController();
  if (poll) clearInterval(poll);
  poll = undefined;
  const p = new URLSearchParams(location.hash.slice(1));
  document
    .getElementById("roles")!
    .classList.toggle("selected", p.has("role") || p.get("view") === "roles");
  document
    .getElementById("canvases")!
    .classList.toggle("selected", !p.has("role") && p.get("view") !== "roles");
  try {
    if (p.has("canvas"))
      await canvas(p.get("canvas")!, p.get("revision") ?? undefined);
    else if (p.has("role")) await role(p.get("role")!);
    else await library(p.get("view") === "roles");
  } catch (e) {
    showError(e);
  }
}
async function start() {
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
  // Telegram's launch fragment is parsed by the SDK; never retain signed data in our navigation URLs.
  const query = new URLSearchParams(location.search);
  const initial = new URLSearchParams();
  for (const key of ["canvas", "revision", "view"])
    if (query.has(key)) initial.set(key, query.get(key)!);
  history.replaceState(null, "", "/miniapp/#" + initial.toString());
  addEventListener("hashchange", () => void route());
  await route();
}
void start().catch(showError);
