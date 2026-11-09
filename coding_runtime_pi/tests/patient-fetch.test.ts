import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { patientFetch } from "../src/patient-fetch.js";

// The host answers a model call only when the generation is done (journal 156).
test("a model reply slower than the default header wait still arrives, with the exact request", async (t) => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () =>
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: request.method,
            id: request.headers["x-call"],
            body,
          }),
        );
      }, 1500),
    );
  }).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  // Callers hand over Node's own Request, as the gateway retry wrapper does.
  const request = () =>
    new Request(url, {
      method: "POST",
      headers: { "x-call": "c1" },
      body: "exact body",
    });
  await assert.rejects(patientFetch(300)(request()));
  const response = await patientFetch(5000)(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "POST",
    id: "c1",
    body: "exact body",
  });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(
    patientFetch(5000)(url, { signal: stop.signal }),
    (error: Error) => error.name === "AbortError",
  );
});

test("Pi waits for a model reply as long as responseTimeoutMs allows, and no longer", async (t) => {
  const { CodingRuntime, TaskStore, compatibleModel } =
    await import("../src/index.js");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  let gap: "headers" | "body" = "headers";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const pause = () => new Promise((resolve) => setTimeout(resolve, 1500));
    // As the host does: nothing is sent until the whole generation is done.
    if (gap === "headers") await pause();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": processing\n\n");
    // The SDK's own timeout ends at the headers; only the patient fetch bounds the body.
    if (gap === "body") await pause();
    res.end(
      chunk(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "plan",
              type: "function",
              function: {
                name: "report",
                arguments: JSON.stringify({
                  kind: "plan",
                  summary: "Slow plan",
                  detail: "Inspect value.js and keep the objective.",
                }),
              },
            },
          ],
        },
        null,
      ) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = await mkdtemp(join(tmpdir(), "pi-patient-fetch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  await mkdir(workspace);
  execFileSync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, "value.js"), "export const value = 1;\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args]);
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const run = async (responseTimeoutMs: number, wrapped = false) => {
    const runtime = new CodingRuntime({
      store: new TaskStore(
        join(root, `state-${randomUUID()}`),
        "synthetic-state-key-32-characters",
      ),
      model: compatibleModel({
        provider: "synthetic",
        model: "synthetic/model",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKey: "synthetic-capability",
        responseTimeoutMs,
        // As the worker configures it: under the gateway retry wrappers.
        ...(wrapped
          ? {
              requestIdField: "runtime_call_id",
              terminalHttpRecovery: { attemptId: randomUUID() },
            }
          : {}),
      }),
    });
    const task = await runtime.start({ workspace, objective: "Keep it" });
    return runtime.run(task.id);
  };
  assert.notEqual((await run(400)).status, "waiting_approval");
  assert.equal((await run(10000)).status, "waiting_approval");
  // A pause in the body ends the run only if the patient fetch carries the request.
  gap = "body";
  for (const wrapped of [false, true]) {
    assert.notEqual((await run(400, wrapped)).status, "waiting_approval");
    assert.equal((await run(10000, wrapped)).status, "waiting_approval");
  }
});
