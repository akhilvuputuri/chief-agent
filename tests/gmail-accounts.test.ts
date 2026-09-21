import test from "node:test";
import assert from "node:assert/strict";
import { GmailTools, GMAIL_RUN_BUDGET } from "../src/gmail.js";
import { action } from "../src/protocol.js";
const config = {
  owner: "owner",
  email: "first@example.com",
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "first",
  secondary: { email: "second@example.com", refreshToken: "second" },
};
function fixture(mismatch = false) {
  const calls: { url: URL; token: string }[] = [];
  const request = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const token =
      new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ??
      "";
    calls.push({ url, token });
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({
        access_token: new URLSearchParams(String(init?.body)).get(
          "refresh_token",
        ),
        expires_in: 3600,
      });
    if (url.pathname.endsWith("/profile"))
      return Response.json({
        emailAddress:
          token === "first" || mismatch ? config.email : config.secondary.email,
      });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [], nextPageToken: token + "-page" });
    if (url.pathname.includes("/threads/"))
      return Response.json({ id: "abc", messages: [] });
    return Response.json({ id: "abc", threadId: "abc", snippet: token });
  }) as typeof fetch;
  return { tools: new GmailTools(config, request), calls };
}
test("accounts are owner-scoped, credential-free and require no Google requests", async () => {
  const { tools, calls } = fixture();
  await assert.rejects(() => tools.call("other", "gmail_accounts", ""));
  const result = await tools.call("owner", "gmail_accounts", "");
  assert.deepEqual(result, {
    accounts: [
      { account: "primary", email: config.email, default: true },
      { account: "secondary", email: config.secondary.email, default: false },
    ],
  });
  assert.equal(calls.length, 0);
});
test("default and explicit account searches/cache/page tokens remain isolated", async () => {
  const { tools, calls } = fixture();
  const a: any = await tools.call(
    "owner",
    "gmail_search",
    "same",
    undefined,
    "run",
  );
  const b: any = await tools.call(
    "owner",
    "gmail_search",
    "same",
    undefined,
    "run",
    "secondary",
  );
  assert.equal(a.account, "primary");
  assert.equal(b.account, "secondary");
  assert.equal(a.nextPageToken, "first-page");
  assert.equal(b.nextPageToken, "second-page");
  const before = calls.length;
  await tools.call(
    "owner",
    "gmail_search",
    "same",
    undefined,
    "run",
    "SECOND@EXAMPLE.COM",
  );
  assert.equal(calls.length, before);
  await tools.call(
    "owner",
    "gmail_search",
    "same",
    b.nextPageToken,
    "run",
    "secondary",
  );
  assert.equal(calls.at(-1)?.url.searchParams.get("pageToken"), "second-page");
  assert.equal(calls.at(-1)?.token, "second");
});
test("message and thread reads select the correct credential even for identical ids", async () => {
  const { tools, calls } = fixture();
  const a: any = await tools.call("owner", "gmail_read", "abc", undefined, "r");
  const b: any = await tools.call(
    "owner",
    "gmail_read",
    "abc",
    undefined,
    "r",
    "secondary",
  );
  assert.equal(a.text, "first");
  assert.equal(b.text, "second");
  assert.equal(b.email, config.secondary.email);
  await tools.call("owner", "gmail_thread", "abc", undefined, "r", "secondary");
  assert.equal(calls.at(-1)?.token, "second");
});
test("unknown accounts and unauthorized callers never dispatch or silently fall back", async () => {
  const { tools, calls } = fixture();
  await assert.rejects(
    () => tools.call("owner", "gmail_search", "x", undefined, "r", "unknown"),
    /Unknown Gmail account/,
  );
  await assert.rejects(() =>
    tools.call("other", "gmail_search", "x", undefined, "r", "secondary"),
  );
  assert.equal(calls.length, 0);
  const single = new GmailTools(
    { ...config, secondary: undefined },
    async () => {
      throw new Error("must not dispatch");
    },
  );
  await assert.rejects(
    () =>
      single.call("owner", "gmail_search", "x", undefined, "r", "secondary"),
    /Unknown Gmail account/,
  );
});
test("secondary profile mismatch is rejected without reading or switching accounts", async () => {
  const { tools, calls } = fixture(true);
  await assert.rejects(
    () => tools.call("owner", "gmail_search", "x", undefined, "r", "secondary"),
    /does not match/,
  );
  assert.equal(calls.length, 2);
});
test("request allocation is shared across accounts", async () => {
  const { tools } = fixture();
  for (let i = 0; i < GMAIL_RUN_BUDGET; i++)
    await tools.call(
      "owner",
      "gmail_search",
      String(i),
      undefined,
      "run",
      i % 2 ? "secondary" : "primary",
    );
  await assert.rejects(
    () =>
      tools.call(
        "owner",
        "gmail_search",
        "over",
        undefined,
        "run",
        "secondary",
      ),
    /budget/,
  );
});
test("validated tool schema permits selectors and rejects credential/owner injection and writes", () => {
  for (const operation of ["gmail_search", "gmail_read", "gmail_thread"]) {
    const args = {
      operation,
      account: "secondary",
      ...(operation === "gmail_search"
        ? { query: "x" }
        : operation === "gmail_read"
          ? { messageId: "abc" }
          : { threadId: "abc" }),
    };
    assert.equal(action.safeParse(args).success, true);
    assert.equal(
      action.safeParse({ ...args, refreshToken: "attacker" }).success,
      false,
    );
    assert.equal(action.safeParse({ ...args, user: "other" }).success, false);
  }
  assert.equal(
    action.safeParse({ operation: "gmail_send", account: "secondary" }).success,
    false,
  );
});
