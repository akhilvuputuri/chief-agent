import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { LinkResolver, postEvidence } from "../src/link-resolution.js";
import {
  publicPostRequest,
  publicPostUrl,
  readPublicPost,
} from "../src/browser/public-links.js";
import { BrowserManager } from "../src/browser/manager.js";
import type { Browser, BrowserContext } from "playwright-core";
import { McpTools } from "../src/mcp.js";
import { McpFailure } from "../src/mcp-client.js";
import type { McpTransport as Transport } from "../src/mcp-client.js";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PublicFeedFetcher } from "../src/news-feed.js";

const share = "https://www.reddit.com/r/worldnews/s/example";
const post = "https://www.reddit.com/r/worldnews/comments/abc123/story/";
const article = "https://www.euronews.com/2026/10/02/example-story";
const html = `<a href="https://ads.example.com/ad">Advertisement</a><shreddit-post id="t3_abc123" content-href="${article}" post-type="link"></shreddit-post><a href="https://comments.example.com">Comment</a>`;
async function fixture() {
  const pg = new PGlite();
  for (const name of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "030_mcp",
    "031_link_resolution",
  ])
    await pg.exec(
      await readFile(new URL(`../db/${name}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  return { pg, db };
}
test("selected post metadata resolves its article; ads/comments and another post are not evidence", () => {
  const evidence = postEvidence(html, post);
  assert.deepEqual(evidence.outbound, [article]);
  assert.equal(evidence.postId, "abc123");
  assert.equal(
    postEvidence(html, post.replace("abc123", "def456")).blocked,
    true,
  );
  const data = [
    {
      kind: "Listing",
      data: {
        children: [
          { kind: "t3", data: { id: "abc123", is_self: false, url: article } },
        ],
      },
    },
  ];
  assert.deepEqual(postEvidence(JSON.stringify(data), post).outbound, [
    article,
  ]);
});
test("JSON crossposts preserve the exact parent relationship and stop cycles", () => {
  const p = {
    id: "abc123",
    url: post,
    crosspost_parent: "t3_def456",
    crosspost_parent_list: [{ id: "def456", url: article, is_self: false }],
  };
  assert.deepEqual(
    postEvidence(
      JSON.stringify([{ data: { children: [{ kind: "t3", data: p }] } }]),
      post,
    ).outbound,
    [article],
  );
  p.crosspost_parent = "t3_wrong";
  assert.equal(
    postEvidence(
      JSON.stringify([{ data: { children: [{ kind: "t3", data: p }] } }]),
      post,
    ).blocked,
    true,
  );
});
test("pseudo-elements and conflicting selected-post nodes never become publisher evidence", () => {
  for (const body of [
    `<!-- ${html} -->`,
    `<script>${html}</script>`,
    `<textarea>${html}</textarea>`,
    `<template>${html}</template>`,
    html + html.replace(article, "https://wrong.example.com/story"),
  ]) {
    assert.equal(postEvidence(body, post).blocked, true);
  }
  assert.deepEqual(
    postEvidence(
      `<!-- ${html.replace(article, "https://wrong.example.com")} -->` + html,
      post,
    ).outbound,
    [article],
  );
});
test("mobile Reddit and blocked shortener destinations cannot be saved as publisher articles", async () => {
  const f = await fixture();
  try {
    const resolver = new LinkResolver(f.db, {
      get: async (_url, _signal, observe) => {
        observe?.(post);
        throw Error("403");
      },
    });
    assert.equal(
      (await resolver.resolve("123", "https://short.example.com/a")).status,
      "blocked",
    );
    const discussion = await resolver.resolve(
      "123",
      "https://short.example.com/a",
      "discussion",
    );
    assert.equal(discussion.status, "discussion");
    assert.equal(discussion.pageUrl, post);
    assert.equal(discussion.articleUrl, null);
    const accessible = new LinkResolver(f.db, {
      get: async () => ({ body: html, finalUrl: post }),
    });
    const selected = await accessible.resolve(
      "456",
      "https://short.example.com/a",
      "discussion",
    );
    assert.equal(selected.status, "discussion");
    assert.equal(selected.articleUrl, null);
    for (const host of ["m.reddit.com", "np.reddit.com"]) {
      const blocked = new LinkResolver(f.db, {
        get: async () => {
          throw Error("403");
        },
      });
      assert.equal(
        (await blocked.resolve("123", post.replace("www.reddit.com", host)))
          .status,
        "blocked",
      );
    }
  } finally {
    await f.pg.close();
  }
});
test("redirect and error streams are cancelled before following or settling; destination survives a 403", async () => {
  const responses: PassThrough[] = [];
  const requests: { destroyed: boolean }[] = [];
  const destinations: string[] = [];
  const replacement = mock.method(https, "request", ((
    _url: unknown,
    _options: unknown,
    callback: any,
  ) => {
    const req = new EventEmitter() as any;
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = () =>
      queueMicrotask(() => {
        const res = new PassThrough() as any;
        res.statusCode = responses.length ? 403 : 302;
        res.headers = responses.length ? {} : { location: post };
        responses.push(res);
        callback(res);
        // A response capable of endless streaming must have been destroyed.
        if (!res.destroyed) res.write(Buffer.alloc(1_600_000));
      });
    requests.push(req);
    return req;
  }) as any);
  try {
    await assert.rejects(
      new PublicFeedFetcher().get(
        "https://short.example.com/a",
        undefined,
        (url) => destinations.push(url),
      ),
      /HTTP 403/,
    );
    assert.deepEqual(destinations, ["https://short.example.com/a", post]);
    assert.equal(responses.length, 2);
    assert.ok(responses.every((res) => res.destroyed));
    assert.ok(requests.every((req) => req.destroyed));
  } finally {
    replacement.mock.restore();
  }
});
test("cancelled browser startup retires its browser and closes any late anonymous context", async () => {
  let finish!: (context: BrowserContext) => void;
  let closed = 0,
    lateClosed = 0;
  const browser = {
    newContext: () =>
      new Promise<BrowserContext>((resolve) => {
        finish = resolve;
      }),
    close: async () => {
      closed++;
    },
  } as unknown as Browser;
  const controller = new AbortController();
  const reading = readPublicPost(browser, post, controller.signal);
  const rejected = assert.rejects(reading);
  controller.abort();
  await rejected;
  assert.equal(closed, 1);
  finish({
    close: async () => {
      lateClosed++;
    },
  } as unknown as BrowserContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateClosed, 1);
  let finishLaunch!: (browser: Browser) => void;
  const manager = new BrowserManager(
    "http://127.0.0.1:9",
    () =>
      new Promise<Browser>((resolve) => {
        finishLaunch = resolve;
      }),
  );
  const launchAbort = new AbortController();
  const pending = manager.call(
    "123",
    randomUUID(),
    { kind: "resolve_public", url: post },
    launchAbort.signal,
  );
  const launchRejected = assert.rejects(pending);
  await new Promise((resolve) => setImmediate(resolve));
  launchAbort.abort();
  await launchRejected;
  finishLaunch(browser);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 2);
});
test("cancellation interrupts page setup even if closing the context does not settle newPage", async () => {
  const controller = new AbortController();
  let closed = 0;
  let started!: () => void;
  const setupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const context = {
    route: async () => {},
    routeWebSocket: async () => {},
    newPage: () => {
      started();
      return new Promise(() => {});
    },
    close: async () => {
      closed++;
    },
  };
  const browser = {
    newContext: async () => context,
    close: async () => {},
  } as unknown as Browser;
  const reading = readPublicPost(browser, post, controller.signal);
  const rejected = assert.rejects(reading);
  await setupStarted;
  controller.abort();
  await rejected;
  assert.equal(closed, 1);
});
test("resolution is owner-scoped, records provenance and never guesses blocked pages", async () => {
  const f = await fixture();
  try {
    const resolver = new LinkResolver(f.db, {
      get: async () => ({ body: html, finalUrl: post }),
    });
    const r = await resolver.resolve("123", share);
    assert.equal(r.articleUrl, article);
    assert.equal(r.originalUrl, share);
    assert.equal(r.status, "resolved");
    const other = new LinkResolver(f.db, {
      get: async () => {
        throw Error("403");
      },
    });
    assert.equal((await other.resolve("456", share)).status, "blocked");
    assert.equal(
      (await resolver.resolve("123", share, "discussion")).pageUrl,
      share,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      resolver.resolve("123", share, "article", controller.signal),
      /cancelled/,
    );
  } finally {
    await f.pg.close();
  }
});
test("browser fallback requires selected-post identity and a unique safe destination", async () => {
  const f = await fixture();
  try {
    const failed = {
      get: async () => {
        throw Error("403");
      },
    };
    const wrong = new LinkResolver(f.db, failed, async () => ({
      pageUrl: post.replace("abc123", "def456"),
      postId: "def456",
      outbound: [article],
      self: false,
      blocked: false,
    }));
    assert.equal((await wrong.resolve("123", post)).status, "blocked");
    const ambiguous = new LinkResolver(f.db, failed, async () => ({
      pageUrl: post,
      postId: "abc123",
      outbound: [article, "https://other.example.com/story"],
      self: false,
      blocked: false,
    }));
    assert.equal((await ambiguous.resolve("456", share)).status, "ambiguous");
  } finally {
    await f.pg.close();
  }
});
test("public browser policy does not inherit invoice cookies or grant mutations/private routes", () => {
  assert.equal(publicPostUrl(share + "?share_id=tracking"), share);
  assert.throws(() => publicPostUrl("https://www.reddit.com/login/"));
  assert.equal(publicPostRequest(post, "POST", "document"), false);
  assert.equal(
    publicPostRequest("https://www.reddit.com/api/vote", "GET", "fetch"),
    false,
  );
  assert.equal(
    publicPostRequest("https://private.internal/", "GET", "document"),
    false,
  );
  assert.equal(publicPostRequest(post, "GET", "document"), true);
});

test("owner-verified observations work only for their owner and do not fabricate fresh network evidence", async () => {
  const f = await fixture();
  try {
    const result = {
      originalUrl: share,
      pageUrl: post,
      articleUrl: article,
      status: "resolved",
      method: "owner_verified",
      reason: "Publisher URL observed from the selected post",
      candidates: [article],
      observedAt: new Date().toISOString(),
    };
    await f.db.query(
      "INSERT INTO link_resolutions(id,user_id,original_url,target,result,expires_at) VALUES($1,'123',$2,'article',$3::jsonb,now()+interval '1 hour')",
      [randomUUID(), share, JSON.stringify(result)],
    );
    let reads = 0;
    const resolver = new LinkResolver(f.db, {
      get: async () => {
        reads++;
        throw Error("403");
      },
    });
    assert.equal(
      (await resolver.resolve("123", share)).method,
      "owner_verified",
    );
    assert.equal(reads, 0);
    assert.equal((await resolver.resolve("456", share)).status, "blocked");
    assert.equal(reads, 1);
    assert.equal(
      (await resolver.resolve("123", article)).method,
      "owner_provided",
    );
  } finally {
    await f.pg.close();
  }
});
test("Reader freezes original intent and resolved wire URL before uncertain writes and replay", async () => {
  const f = await fixture();
  try {
    let resolves = 0,
      submitted: string[] = [];
    const links = new LinkResolver(f.db, {
      get: async () => {
        resolves++;
        return { body: html, finalUrl: post };
      },
    });
    const registry = {
      version: 1,
      connections: [
        {
          id: "reader",
          url: "https://reader.example.com/mcp",
          credential: "reader",
          description: "Reader",
          tools: [
            {
              name: "save_link",
              mode: "idempotent_write",
              idempotencyArgument: "idempotency_key",
              result: "reader_receipt",
            },
          ],
        },
      ],
    };
    const schema = {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        idempotency_key: { type: "string" },
      },
      required: ["url", "idempotency_key"],
      additionalProperties: false,
    };
    const transport: Transport = async (_url, _token, use) =>
      use({
        list: async () => [{ name: "save_link", inputSchema: schema }],
        call: async (_name, args) => {
          submitted.push(String(args.url));
          if (submitted.length === 1) throw new McpFailure("uncertain");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  submission_id: randomUUID(),
                  status: "ready",
                  duplicate: true,
                }),
              },
            ],
          };
        },
      });
    const tools = new McpTools(
      f.db,
      registry,
      { reader: { owner: "123", token: "synthetic-reader-test-credential" } },
      transport,
      undefined,
      links,
    );
    const a = {
      operation: "mcp_write",
      connection: "reader",
      tool: "save_link",
      requestKey: randomUUID(),
      arguments: { url: share },
    };
    assert.equal(((await tools.call("123", a)) as any).state, "pending");
    const row = (await f.db.query("SELECT * FROM mcp_operations")).rows[0];
    assert.equal(row.payload.url, article);
    assert.equal(row.source_payload.url, share);
    assert.equal(
      ((await tools.call("123", { ...a, arguments: undefined })) as any).state,
      "complete",
    );
    assert.deepEqual(submitted, [article, article]);
    assert.equal(resolves, 1);
    await assert.rejects(
      tools.call("123", { ...a, readerTarget: "discussion" }),
      /bound/,
    );
    submitted = [];
    const discussion = {
      ...a,
      requestKey: randomUUID(),
      readerTarget: "discussion",
    };
    assert.equal(
      ((await tools.call("123", discussion)) as any).state,
      "pending",
    );
    assert.equal(
      (
        (await tools.call("123", {
          ...discussion,
          readerTarget: undefined,
          arguments: undefined,
        })) as any
      ).state,
      "complete",
    );
    assert.deepEqual(submitted, [share, share]);
    await assert.rejects(
      tools.call("123", { ...discussion, readerTarget: "article" }),
      /bound/,
    );
  } finally {
    await f.pg.close();
  }
});
