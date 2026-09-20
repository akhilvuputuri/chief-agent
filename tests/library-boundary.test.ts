import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  hosts,
  permitted,
  routeFor,
  routes,
  type RouteEntry,
} from "../src/library-routes.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";

const inventory: Record<string, [RouteEntry["method"], string]> = {
  libraryInfo: ["GET", "/v2/libraries/nlb"],
  mediaSearch: ["GET", "/v2/libraries/nlb/media"],
  mediaInfo: ["GET", "/v2/libraries/nlb/media/{titleId}"],
  mediaAvailability: ["GET", "/v2/libraries/nlb/media/availability"],
  chipMint: ["POST", "/chip"],
  chipCloneCode: ["GET", "/chip/clone/code"],
  chipCloneEnter: ["POST", "/chip/clone/code"],
  chipClone: ["POST", "/chip/clone"],
  chipSync: ["GET", "/chip/sync"],
  chipRevoke: ["POST", "/chip/revoke"],
  loanCreate: ["POST", "/card/{cardId}/loan/{titleId}"],
  holdCreate: ["POST", "/card/{cardId}/hold/{titleId}"],
  holdDelete: ["DELETE", "/card/{cardId}/hold/{titleId}"],
};

async function sourceFiles() {
  const dir = new URL("../src/", import.meta.url);
  return Promise.all(
    (await readdir(dir))
      .filter((f) => f.endsWith(".ts"))
      .map(async (f) => [f, await readFile(new URL(f, dir), "utf8")] as const),
  );
}

test("the route inventory is the complete (method, path) surface and excludes return, renew, download and login", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(routes).map(([k, r]) => [k, [r.method, r.template]]),
    ),
    inventory,
  );
  const entries = Object.values(routes) as RouteEntry[];
  assert.ok(entries.every((r) => r.method !== ("PUT" as string)));
  const deletes = entries.filter((r) => r.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!.template, /\/hold\//);
  const loan = entries.filter((r) => r.template.includes("/loan/"));
  assert.equal(loan.length, 1);
  assert.equal(loan[0]!.method, "POST");
  assert.deepEqual(
    entries.filter((r) => r.unattended).map((r) => r.template),
    ["/chip"],
  );
});

test("hostnames live only in library-routes.ts and no source constructs a forbidden segment", async () => {
  const forbidden =
    /\/return\b|\/renew\b|\/fulfill|\/download\b|\/auth\/link|openbook|\.acsm/i;
  for (const [file, text] of await sourceFiles()) {
    if (file !== "library-routes.ts")
      for (const host of Object.values(hosts))
        assert.ok(!text.includes(host), `${file} names ${host}`);
    assert.ok(
      !forbidden.test(text),
      `${file} contains a forbidden route segment`,
    );
  }
});

test("URLs can only be built from route templates with validated parameters", () => {
  assert.equal(
    permitted("mediaAvailability", {}, { titleIds: "1,2" }).href,
    "https://thunder.api.overdrive.com/v2/libraries/nlb/media/availability?titleIds=1%2C2",
  );
  assert.throws(() => permitted("mediaInfo", { titleId: "1/return" }));
  assert.throws(() => permitted("mediaInfo", {}));
  assert.throws(() =>
    permitted("loanCreate", { cardId: "c", titleId: "../x" }),
  );
  const loan = new URL("https://sentry.libbyapp.com/card/c1/loan/5665700");
  assert.equal(routeFor(loan, "POST"), "loanCreate");
  assert.equal(routeFor(loan, "DELETE"), null);
  assert.equal(routeFor(loan, "PUT"), null);
  assert.equal(
    routeFor(new URL("https://example.com/v2/libraries/nlb"), "GET"),
    null,
  );
});

test("catalogue reads are journaled as reads and only offered when the library flag is set", () => {
  assert.equal(readOperations.has("library_check"), true);
  assert.equal(readOperations.has("library_availability"), true);
  const names = (flags: Record<string, boolean>) =>
    runtimeContext(flags, null).tools.map((t) => t.name);
  assert.ok(!names({}).some((n) => n.startsWith("library_")));
  const enabled = names({ library: true }).filter((n) =>
    n.startsWith("library_"),
  );
  assert.deepEqual(enabled.sort(), ["library_availability", "library_check"]);
  const tool = runtimeContext({ library: true }, null).tools.find(
    (t) => t.name === "library_check",
  )!;
  assert.deepEqual(tool.parameters.required, ["query"]);
});
