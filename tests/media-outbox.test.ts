import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { MediaOutbox, type OutgoingMedia } from "../src/media-outbox.js";
import type { Database } from "../src/db.js";
import { SingaporeTools } from "../src/singapore/tools.js";
import { action } from "../src/protocol.js";

const picture = (name: string): OutgoingMedia => ({
  kind: "photo",
  bytes: Buffer.from(name),
  filename: `${name}.png`,
  caption: name,
});

test("the outbox keeps the latest pictures per run, for a while, and hands each out once", () => {
  let now = 0;
  const outbox = new MediaOutbox(() => now);
  for (const name of ["a", "b", "c", "d"]) outbox.put("run", picture(name));
  outbox.put("other", { ...picture("long"), caption: "x".repeat(2000) });
  assert.deepEqual(
    outbox.take(["run"]).map((m) => m.caption),
    ["b", "c", "d"],
  );
  assert.deepEqual(outbox.take(["run"]), []);
  // Pictures from several runs come out in the order they were queued, whatever the run order.
  outbox.put("second", picture("first map"));
  outbox.put("first", picture("then loop"));
  assert.deepEqual(
    outbox.take(["first", "second"]).map((m) => m.caption),
    ["first map", "then loop"],
  );
  assert.equal(outbox.take(["other"])[0]!.caption.length, 1024);
  outbox.put("old", picture("old"));
  now = 16 * 60_000;
  assert.deepEqual(outbox.take(["old"]), []);
  // Only the ten most recent runs are kept.
  for (let i = 0; i < 12; i++) outbox.put(`r${i}`, picture(`p${i}`));
  assert.deepEqual(outbox.take(["r0", "r1"]), []);
  assert.equal(outbox.take(["r11"]).length, 1);
});

test("a run's pictures include those of the agent runs it started", async () => {
  const pg = new PGlite();
  await pg.exec(
    "CREATE TABLE events (id bigserial PRIMARY KEY, run_id uuid NOT NULL, user_id text NOT NULL, type text NOT NULL, data jsonb NOT NULL DEFAULT '{}')",
  );
  const db = pg as unknown as Database;
  const parent = "00000000-0000-4000-8000-000000000001";
  const child = "00000000-0000-4000-8000-000000000002";
  const stranger = "00000000-0000-4000-8000-000000000003";
  await db.query(
    "INSERT INTO events(run_id,user_id,type,data) VALUES ($1,'owner','agent.started',$2), ($1,'someone','agent.started',$3)",
    [
      parent,
      JSON.stringify({ childRunId: child }),
      JSON.stringify({ childRunId: stranger }),
    ],
  );
  const outbox = new MediaOutbox();
  outbox.put(child, picture("radar"));
  outbox.put(stranger, picture("not yours"));
  assert.deepEqual(
    (await outbox.takeForRun(db, "owner", parent)).map((m) => m.caption),
    ["radar"],
  );
  assert.equal(outbox.take([stranger]).length, 1);
});

test("sg_rain queues a picture only when asked and when it has a run", async () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAMAAACeL25MAAAABlBMVEX///8A///r5MGBAAAAAnRSTlMA/1uRIrUAAAARSURBVHicY2BgYGRkgBJQAAAATAAFXSJXTAAAAABJRU5ErkJggg==",
    "base64",
  );
  const fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith("dgs-backend")) return new Response(PNG);
    const date = url.searchParams.get("date") ?? "2026-10-20T15:00:00";
    return Response.json({
      code: 0,
      data: {
        boundaryBox: {
          upperLeft: { longitude: 103.342685, latitude: 1.97854 },
          lowerRight: { longitude: 104.602315, latitude: 0.719515 },
        },
        records: [
          {
            timestamp: `${date}+08:00`,
            image: {
              url: `https://dgs-backend-app-assets-production.s3.ap-southeast-1.amazonaws.com/nea-rain-radar-images/png/70km/${date}.png`,
            },
          },
        ],
      },
    });
  }) as typeof globalThis.fetch;
  const outbox = new MediaOutbox();
  const tools = new SingaporeTools({
    fetch,
    sleep: async () => {},
    now: () => Date.parse("2026-10-20T15:02:00+08:00"),
    dataGovKey: "k",
    media: outbox,
  });
  const ask = (picture?: string) =>
    action.parse({
      operation: "sg_rain",
      lat: 1.35,
      lon: 103.85,
      hours: 0.25,
      ...(picture ? { picture } : {}),
    }) as Parameters<SingaporeTools["call"]>[0];
  const plain: any = await tools.call(ask(), { run: "r" });
  assert.equal(plain.picture, undefined);
  const animated: any = await tools.call(ask("animation"), { run: "r" });
  assert.equal(animated.picture.status, "queued");
  assert.equal(animated.picture.kind, "animation");
  const [queued] = outbox.take(["r"]);
  assert.equal(queued!.kind, "animation");
  assert.equal(queued!.bytes.subarray(0, 6).toString("latin1"), "GIF89a");
  assert.match(
    queued!.caption,
    /^Rain radar 14:45–15:00 SGT, 1.3500, 103.8500 marked\./,
  );
  assert.match(queued!.caption, /map: URA region boundaries/);
  assert.match(queued!.caption, /Singapore Open Data Licence/);
  const map: any = await tools.call(ask("map"), { run: "r" });
  assert.equal(map.picture.kind, "photo");
  assert.equal(outbox.take(["r"])[0]!.bytes.subarray(1, 4).toString(), "PNG");
  const nowhere: any = await tools.call(ask("map"));
  assert.equal(nowhere.picture.status, "unavailable");
});
