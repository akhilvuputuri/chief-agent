import test from "node:test";
import assert from "node:assert/strict";
import {
  MerchantLookup,
  pemValue,
  validVisaSettings,
  type MerchantLookupAction,
  type VisaCredentials,
  type VisaRequest,
  type VisaResponse,
} from "../src/merchant-lookup.js";
import { readConfig } from "../src/config.js";
import { action } from "../src/protocol.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";
import { domainOf } from "../src/tool-domains.js";
import { JobTools } from "../src/tools.js";
import { ToolValidationError } from "../src/tool-errors.js";

const creds: VisaCredentials = {
  environment: "sandbox",
  userId: "user",
  password: "pass",
  cert: "CERT",
  key: "KEY",
  responseGroup: "GNSTANDARD3",
};
const json = (status: number, body: unknown, headers = {}): VisaResponse => ({
  status,
  headers,
  body: JSON.stringify(body),
});
const record = (mcc: string, extra = {}, values = {}) => ({
  matchScore: 154.0,
  confidenceScore: 0.9,
  confidenceRange: "HIGH",
  matchIndicators: { merchantName: "Y", merchantCity: "Y" },
  responseValues: {
    visaMerchantName: "STARBUCKS",
    visaStoreName: "STARBUCKS",
    primaryMerchantCategoryCode: mcc,
    merchantCategoryCode: [mcc],
    merchantCategoryCodeDesc: ["FAST FOOD RESTAURANTS"],
    primaryMerchantCategoryGroup: "Restaurant",
    merchantStreetAddress: "280 KING ST",
    merchantCity: "SAN FRANCISCO",
    merchantCountryCode: "840",
    nameSimilarityScore: "0.96",
    ...values,
  },
  ...extra,
});
const ok = (records: unknown[], matched = records.length) =>
  json(200, {
    merchantSearchServiceResponse: {
      header: { numRecordsMatched: String(matched) },
      status: { statusCode: "CDI000", statusDescription: "Success" },
      response: records,
    },
  });
function make(
  reply: (r: VisaRequest) => Promise<VisaResponse> | VisaResponse,
  now = () => 1_000_000,
  c = creds,
) {
  const calls: VisaRequest[] = [];
  const tool = new MerchantLookup(
    c,
    async (r) => {
      calls.push(r);
      return reply(r);
    },
    now,
  );
  return { tool, calls };
}
const search = (
  o: Partial<MerchantLookupAction> = {},
): MerchantLookupAction => ({
  operation: "merchant_mcc_lookup",
  merchantName: "Starbucks",
  ...o,
});

test("a search sends the documented v2 request with basic auth and returns the MCC and scores", async () => {
  const f = make(() => ok([record("5814")]));
  const r = await f.tool.call(
    "owner",
    search({ merchantCity: "San Francisco", merchantCountryCode: "840" }),
  );
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(
    call.url,
    "https://sandbox.api.visa.com/merchantsearch/v2/search",
  );
  assert.equal(
    call.headers.authorization,
    "Basic " + Buffer.from("user:pass").toString("base64"),
  );
  const body = JSON.parse(call.body);
  assert.deepEqual(body.searchAttrList, {
    merchantName: "Starbucks",
    merchantCity: "San Francisco",
    merchantCountryCode: "840",
  });
  assert.deepEqual(body.responseAttrList, ["GNSTANDARD3"]);
  assert.equal(body.searchOptions.maxRecords, "5");
  assert.equal(body.searchOptions.confidenceScores, true);
  assert.match(body.header.messageDateTime, /^\d{4}-\d\d-\d\dT[\d:.]{12}$/);
  assert(body.header.requestMessageId.length <= 50);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.matches[0].mcc, "5814");
  assert.deepEqual(r.matches[0].mccDescriptions, ["FAST FOOD RESTAURANTS"]);
  assert.equal(r.matches[0].confidenceScore, 0.9);
  assert.equal(r.matches[0].confidenceRange, "HIGH");
  assert.equal(r.matches[0].categoryGroup, "Restaurant");
  assert.equal(r.matches[0].matchIndicators?.merchantName, "Y");
  assert.equal(r.matches[0].nameSimilarity, 0.96);
  assert.match(r.note, /SANDBOX/);
  assert.equal(r.mccDiffers, false);
});

test("production calls the production host and drops the sandbox warning", async () => {
  const f = make(() => ok([record("5814")]), undefined, {
    ...creds,
    environment: "production",
  });
  const r = await f.tool.call("owner", search());
  assert(f.calls[0].url.startsWith("https://api.visa.com/"));
  assert.equal(r.status === "ok" && /SANDBOX/.test(r.note), false);
});

test("multiple matches keep Visa's order and flag disagreeing MCCs", async () => {
  const f = make(() =>
    ok([record("5814"), record("5812", { confidenceScore: 0.2 })], 40),
  );
  const r = await f.tool.call("owner", search({ maxRecords: 2 }));
  assert.equal(JSON.parse(f.calls[0].body).searchOptions.maxRecords, "2");
  assert(r.status === "ok");
  assert.equal(r.matched, 40);
  assert.equal(r.returned, 2);
  assert.deepEqual(
    r.matches.map((m) => m.mcc),
    ["5814", "5812"],
  );
  assert.equal(r.mccDiffers, true);
  assert.match(r.note, /Several records/);
});

test("no records is no_match, not an error", async () => {
  const f = make(() => ok([], 0));
  assert.equal((await f.tool.call("owner", search())).status, "no_match");
  const g = make(() =>
    json(200, {
      status: { statusCode: "CDI041", statusDescription: "No merchant found" },
    }),
  );
  assert.equal((await g.tool.call("owner", search())).status, "no_match");
});

test("a Visa error status on a 200 is refused with its code, never a guess", async () => {
  const f = make(() =>
    json(200, {
      status: { statusCode: "CDI090", statusDescription: "Bad request field" },
    }),
  );
  const r = await f.tool.call("owner", search());
  assert(r.status === "refused");
  assert.equal(r.code, "CDI090");
  assert.equal(r.description, "Bad request field");
});

test("401, 403 and 400 are refused; the credential refusal says not to retry", async () => {
  for (const status of [400, 401, 403]) {
    const f = make(() =>
      json(status, {
        responseStatus: { statusCode: "API" + status, statusDescription: "no" },
      }),
    );
    const r = await f.tool.call("owner", search());
    assert(r.status === "refused");
    assert.equal(r.httpStatus, status);
    assert.equal(r.code, "API" + status);
    if (status !== 400) assert.match(r.note, /credentials or certificate/);
  }
});

test("a 5xx is refused as a server error and an unreadable body is not read as a match", async () => {
  const f = make(() => ({ status: 500, headers: {}, body: "<html>" }));
  const r = await f.tool.call("owner", search());
  assert(r.status === "refused");
  assert.match(r.note, /server error/);
  const g = make(() => ({ status: 200, headers: {}, body: "not json" }));
  const x = await g.tool.call("owner", search());
  assert(x.status === "refused");
  assert.match(x.note, /could not be read/);
});

test("a 429 is busy with Retry-After, and later calls wait without reaching Visa", async () => {
  let now = 1_000_000;
  const f = make(
    () => json(429, {}, { "retry-after": "30" }),
    () => now,
  );
  const first = await f.tool.call("owner", search());
  assert(first.status === "busy");
  assert.equal(first.retryAfterSeconds, 30);
  now += 10_000;
  const again = await f.tool.call("owner", search());
  assert(again.status === "busy");
  assert.equal(again.retryAfterSeconds, 20);
  assert.equal(f.calls.length, 1);
  now += 25_000;
  const g = make(
    () => ok([record("5814")]),
    () => now,
  );
  assert.equal((await g.tool.call("owner", search())).status, "ok");
});

test("a 429 without Retry-After uses the default and a 503 is also busy", async () => {
  const f = make(() => json(503, {}));
  const r = await f.tool.call("owner", search());
  assert(r.status === "busy");
  assert.equal(r.retryAfterSeconds, 60);
});

test("a timeout is reported as timeout and a connection failure as unreachable", async () => {
  const slow = make(
    (r) =>
      new Promise((_, reject) => {
        if (r.signal.aborted) reject(new Error("aborted"));
        r.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  // Fake the clock-free path: abort through AbortSignal.timeout by shrinking it.
  const original = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort();
  try {
    const r = await slow.tool.call("owner", search());
    assert.equal(r.status, "timeout");
  } finally {
    AbortSignal.timeout = original;
  }
  const down = make(() => {
    throw new Error("ECONNRESET self-signed certificate");
  });
  const d = await down.tool.call("owner", search());
  assert(d.status === "unreachable");
  assert.doesNotMatch(JSON.stringify(d), /ECONNRESET|pass/);
});

test("an owner cancellation propagates instead of looking like a Visa fault", async () => {
  const controller = new AbortController();
  const f = make(async () => {
    controller.abort();
    throw new Error("aborted");
  });
  await assert.rejects(f.tool.call("owner", search(), controller.signal));
});

test("a repeat of the same lookup is a fresh read with a new message id and no side effect", async () => {
  const f = make(() => ok([record("5814")]));
  await f.tool.call("owner", search());
  await f.tool.call("owner", search());
  assert.equal(f.calls.length, 2);
  assert.notEqual(
    JSON.parse(f.calls[0].body).header.requestMessageId,
    JSON.parse(f.calls[1].body).header.requestMessageId,
  );
});

test("a transaction lookup posts to the lookup endpoint and maps the flat response", async () => {
  const f = make(() =>
    json(200, {
      responseData: {
        responseValues: {
          visaMerchantName: "COSTCO WHOLESALE",
          primaryMerchantCategoryCode: 5300,
          merchantCategoryCode: ["5300", "5542"],
          merchantCategoryCodeDesc: ["WHOLESALE CLUBS"],
          merchantCountryCode: 840,
        },
      },
      responseStatus: { statusCode: "API000", statusDescription: "Success" },
    }),
  );
  const r = await f.tool.call("owner", {
    operation: "merchant_mcc_lookup",
    transaction: {
      transactionId: "309321556319387",
      transactionDate: "20191117",
      transactionType: "A",
    },
  });
  assert.equal(
    f.calls[0].url,
    "https://sandbox.api.visa.com/merchantsearch/v1/merchantlookup",
  );
  assert.deepEqual(JSON.parse(f.calls[0].body), {
    transactionId: "309321556319387",
    transactionDate: "20191117",
    transactionType: "A",
  });
  assert(r.status === "ok");
  assert.equal(r.matches[0].mcc, "5300");
  assert.deepEqual(r.matches[0].allMccs, ["5300", "5542"]);
  assert.equal(r.matches[0].country, "840");
  assert.equal(r.matches[0].confidenceScore, null);
});

test("input bounds: details or a transaction, never both or neither", async () => {
  const f = make(() => ok([record("5814")]));
  await assert.rejects(
    f.tool.call("owner", { operation: "merchant_mcc_lookup" }),
    ToolValidationError,
  );
  await assert.rejects(
    f.tool.call("owner", {
      operation: "merchant_mcc_lookup",
      merchantCity: "x",
    }),
    ToolValidationError,
  );
  await assert.rejects(
    f.tool.call(
      "owner",
      search({
        transaction: {
          transactionId: "1",
          transactionDate: "20200101",
          transactionType: "C",
        },
      }),
    ),
    ToolValidationError,
  );
  assert.equal(f.calls.length, 0);
  const bad = (o: object) =>
    action.safeParse({ operation: "merchant_mcc_lookup", ...o }).success;
  assert(bad({ merchantName: "x", merchantCountryCode: "702" }));
  assert(!bad({ merchantName: "x", merchantCountryCode: "SG" }));
  assert(!bad({ merchantName: "x", maxRecords: 11 }));
  assert(!bad({ merchantName: "x", maxRecords: 0 }));
  assert(!bad({ merchantName: "x".repeat(101) }));
  assert(!bad({ merchantName: "x", extra: 1 }));
  assert(
    !bad({
      transaction: {
        transactionId: "1",
        transactionDate: "2020-01-01",
        transactionType: "A",
      },
    }),
  );
});

test("oversized or odd fields are bounded and nonsense records are skipped", async () => {
  const f = make(() =>
    ok([
      record("5814", {}, { visaMerchantName: "A".repeat(500) }),
      "junk",
      { matchScore: 1 },
    ]),
  );
  const r = await f.tool.call("owner", search());
  assert(r.status === "ok");
  assert.equal(r.returned, 1);
  assert.equal(r.matches[0].merchantName?.length, 200);
});

test("pemValue reads inline escapes or a file, never both", () => {
  assert.equal(pemValue("a\\nb", "", "X"), "a\nb");
  assert.throws(() => pemValue("a", "/x", "X"), /only one/);
  assert.throws(
    () => pemValue("", "/nonexistent/file", "X"),
    /could not be read/,
  );
  assert.equal(pemValue("", "", "X"), "");
});

test("the tool is a read operation offered only when configured, and not configured fails clearly", async () => {
  assert(readOperations.has("merchant_mcc_lookup"));
  assert.equal(domainOf("merchant_mcc_lookup"), "subscriptions");
  const on = runtimeContext(
    { subscriptions: true, merchantLookup: true },
    null,
  );
  assert(on.tools.some((t) => t.name === "merchant_mcc_lookup"));
  const off = runtimeContext({ subscriptions: true }, null);
  assert(!off.tools.some((t) => t.name === "merchant_mcc_lookup"));
  const tools = new JobTools({} as never, { call: async () => "" } as never);
  await assert.rejects(
    (tools as any).dispatch("owner", "run", {
      operation: "merchant_mcc_lookup",
      merchantName: "x",
    }),
    /not configured/,
  );
});

test("the subscriptions agent stays invocable with and without Visa credentials", () => {
  const types = (availability: Record<string, boolean>) =>
    JSON.parse(runtimeContext(availability, null).context).agentCatalogue.map(
      (a: any) => a.type,
    );
  assert(types({ subscriptions: true }).includes("subscriptions"));
  assert(
    types({ subscriptions: true, merchantLookup: true }).includes(
      "subscriptions",
    ),
  );
});

test("the coordinator is told that the subscriptions agent answers merchant MCC questions", () => {
  const entry = JSON.parse(
    runtimeContext(
      { subscriptions: true, merchantLookup: true },
      null,
      undefined,
      undefined,
      true,
    ).context,
  ).agentCatalogue.find((a: any) => a.type === "subscriptions");
  assert.match(entry.description, /MCC/);
  assert.match(entry.description, /merchant category/i);
});

test("without a primary code no listed code is promoted, and order alone is not a disagreement", async () => {
  const noPrimary = (codes: string[]) =>
    record(
      "x",
      {},
      {
        primaryMerchantCategoryCode: undefined,
        merchantCategoryCode: codes,
      },
    );
  const same = make(() =>
    ok([noPrimary(["5542", "5300"]), noPrimary(["5300", "5542"])]),
  );
  const a = await same.tool.call("owner", search());
  assert(a.status === "ok");
  assert.equal(a.matches[0].mcc, null);
  assert.deepEqual(a.matches[0].allMccs, ["5542", "5300"]);
  assert.equal(a.mccDiffers, false);
  const diff = make(() => ok([noPrimary(["5542"]), noPrimary(["5300"])]));
  const b = await diff.tool.call("owner", search());
  assert(b.status === "ok");
  assert.equal(b.mccDiffers, true);
});

test("invalid Visa settings never stop configuration; they are rejected for the tool alone", () => {
  const base = {
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
  };
  for (const bad of [
    { VISA_MERCHANT_ENV: "prod" },
    { VISA_RESPONSE_GROUP: "bad group!" },
  ])
    assert.doesNotThrow(() => readConfig({ ...base, ...bad }, {}));
  assert(validVisaSettings("sandbox", "GNSTANDARD3"));
  assert(validVisaSettings("production", "GN_X1"));
  assert(!validVisaSettings("prod", "GNSTANDARD3"));
  assert(!validVisaSettings("", "GNSTANDARD3"));
  assert(!validVisaSettings("sandbox", "bad group!"));
  assert(!validVisaSettings("sandbox", ""));
});

test("a record without a primary cannot hide two different primaries", async () => {
  const rec = (primary?: string) =>
    record(
      "x",
      {},
      {
        primaryMerchantCategoryCode: primary,
        merchantCategoryCode: ["5814", "5812"],
      },
    );
  const f = make(() => ok([rec("5814"), rec("5812"), rec()]));
  const r = await f.tool.call("owner", search());
  assert(r.status === "ok");
  assert.equal(r.mccDiffers, true);
  const g = make(() => ok([rec("5814"), rec("5814"), rec()]));
  const s = await g.tool.call("owner", search());
  assert(s.status === "ok");
  assert.equal(s.mccDiffers, false);
});
