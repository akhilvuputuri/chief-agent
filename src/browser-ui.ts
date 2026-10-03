// This UI is the authenticated owner's handoff. No credentials enter model context or browser storage.
export async function browserView(
  root: HTMLElement,
  token: string,
  id: string,
  signal: AbortSignal,
) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const infoResponse = await fetch(
    "/api/miniapp/browser/" + encodeURIComponent(id),
    {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      signal,
    },
  );
  if (!infoResponse.ok)
    throw new Error(
      "This browser handoff is unavailable. Ask Chief to reopen it.",
    );
  const info = await infoResponse.json();
  signal.throwIfAborted();
  root.replaceChildren(
    el("h1", "Browser handoff"),
    el(
      "p",
      `${info.target?.label ?? "Invoices"} · ${info.target?.month ?? ""}${info.target?.accountLabel ? " · " + info.target.accountLabel : ""}`,
    ),
    el("p", info.notice),
  );
  if (info.state !== "owner") {
    root.append(
      el(
        "p",
        "The browser is ready for the agent. Return to Chief to continue, or ask for a new handoff.",
      ),
    );
    return;
  }
  const location = el("p", info.origin),
    status = el("p", "Connecting…"),
    image = el("img");
  image.alt = "Your remote browser";
  image.className = "browser-screen";
  image.tabIndex = 0;
  const input = el("input");
  input.type = "password";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Text to enter in the browser");
  input.placeholder = "Type here, then send to the focused browser field";
  const reveal = el("input");
  reveal.type = "checkbox";
  const revealLabel = el("label", "Show typed text");
  revealLabel.prepend(reveal);
  reveal.addEventListener(
    "change",
    () => (input.type = reveal.checked ? "text" : "password"),
  );
  const remember = el("input");
  remember.type = "checkbox";
  const rememberLabel = el("label", "Keep this login for later gathering");
  rememberLabel.prepend(remember);
  const count = el("input");
  count.type = "number";
  count.min = "1";
  count.max = "100";
  count.inputMode = "numeric";
  count.setAttribute(
    "aria-label",
    "Invoice count for the requested account and month",
  );
  const countLabel = el(
    "label",
    `How many invoices does the history show for ${info.target?.month ?? "this month"}?`,
  );
  countLabel.append(count);
  const controls = el("div");
  controls.className = "browser-controls";
  root.append(
    location,
    status,
    image,
    controls,
    input,
    revealLabel,
    countLabel,
    rememberLabel,
  );
  const protocol = locationProtocol();
  let ws: WebSocket | undefined,
    poll: ReturnType<typeof setInterval> | undefined,
    ready = false,
    pending = false,
    blobUrl: string | undefined;
  function locationProtocol() {
    return window.location.protocol === "https:" ? "wss:" : "ws:";
  }
  const send = (message: unknown) => {
    if (!ready || pending || ws?.readyState !== WebSocket.OPEN) return;
    pending = true;
    ws.send(JSON.stringify(message));
  };
  const button = (text: string, message: () => unknown) => {
    const b = el("button", text);
    b.type = "button";
    b.addEventListener("click", () => {
      if (ready && !pending && ws?.readyState === WebSocket.OPEN)
        send(message());
    });
    controls.append(b);
  };
  button("Send text", () => {
    const text = input.value;
    input.value = "";
    return { kind: "text", text };
  });
  for (const key of ["Tab", "Enter", "Backspace", "Escape"])
    button(key, () => ({ kind: "key", key }));
  button("Scroll up", () => ({ kind: "scroll", delta: -500 }));
  button("Scroll down", () => ({ kind: "scroll", delta: 500 }));
  button("Back", () => ({ kind: "back" }));
  button("Done", () => ({
    kind: "done",
    remember: remember.checked,
    ...(count.value ? { expectedInvoices: Number(count.value) } : {}),
  }));
  button("Close browser", () => ({ kind: "close" }));
  image.addEventListener("click", (event) => {
    const rect = image.getBoundingClientRect();
    send({
      kind: "click",
      x: Math.min(
        1280,
        Math.max(0, ((event.clientX - rect.left) * 1280) / rect.width),
      ),
      y: Math.min(
        800,
        Math.max(0, ((event.clientY - rect.top) * 800) / rect.height),
      ),
    });
  });
  const ticketResponse = await fetch(
    "/api/miniapp/browser-ticket/" + encodeURIComponent(id),
    {
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      signal,
    },
  );
  if (!ticketResponse.ok)
    throw new Error(
      "Browser connection could not be authorized. Reopen from Chief.",
    );
  const ticket = (await ticketResponse.json()).ticket;
  signal.throwIfAborted();
  ws = new WebSocket(
    protocol +
      "//" +
      window.location.host +
      "/api/miniapp/browser-control/" +
      encodeURIComponent(id),
    ["chief-browser"],
  );
  ws.addEventListener("open", () =>
    ws?.send(JSON.stringify({ kind: "auth", ticket })),
  );
  ws.addEventListener("message", (event) => {
    pending = false;
    const data = JSON.parse(String(event.data));
    if (data.type === "ready") {
      ready = true;
      status.textContent =
        "You control the browser. Click a field in the image, type above and send it. The agent waits.";
      send({ kind: "frame" });
    } else if (data.type === "frame") {
      location.textContent = data.origin + data.path;
      status.textContent = "You control this browser. The agent waits.";
      const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      image.src = blobUrl;
    } else if (data.type === "saved") {
      ready = false;
      if (poll) clearInterval(poll);
      input.value = "";
      image.remove();
      controls.remove();
      input.remove();
      status.textContent = data.notice;
      root.append(el("p", `Continue in Telegram: /continue ${data.taskId}`));
      ws?.close();
    } else if (data.type === "closed") {
      ready = false;
      status.textContent =
        "Browser closed. The collection and its captured files remain saved.";
      ws?.close();
    } else if (data.type === "error") {
      status.textContent = data.message;
      ready = false;
      ws?.close();
    }
  });
  ws.addEventListener("close", () => {
    if (poll) clearInterval(poll);
    ready = false;
    pending = false;
    if (status.textContent?.startsWith("You control"))
      status.textContent = "Disconnected. Reopen the handoff to continue.";
  });
  ws.addEventListener("error", () => {
    status.textContent =
      "The browser connection is unavailable. Reopen from Chief.";
  });
  poll = setInterval(() => {
    if (ready && !pending) send({ kind: "frame" });
  }, 1200);
  signal.addEventListener(
    "abort",
    () => {
      if (poll) clearInterval(poll);
      ws?.close();
      input.value = "";
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    },
    { once: true },
  );
}
