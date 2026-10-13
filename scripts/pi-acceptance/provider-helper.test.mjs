import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const helper = await readFile(
  new URL("./provider-helper.mjs", import.meta.url),
  "utf8",
);
const input = {
  callId: "11111111-1111-4111-8111-111111111111",
  model: "openai/gpt-6.1-sol",
  messages: [],
  tools: [],
  maxOutputTokens: 4096,
  purpose: "compaction",
  stream: true,
  cacheKey: "coding:fixture:1:leader",
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-helper-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await symlink(
    fileURLToPath(new URL("../../node_modules", import.meta.url)),
    join(root, "node_modules"),
  );
  await writeFile(
    join(root, "dist/config.js"),
    `export const readConfig=()=>({OPENROUTER_API_KEY:'synthetic',OPENROUTER_MAX_INPUT_PRICE:.5,OPENROUTER_MAX_OUTPUT_PRICE:.9});`,
  );
  await writeFile(
    join(root, "dist/model.js"),
    `import fs from 'node:fs';export class ModelError extends Error{constructor(diagnostics={failureCode:'controlled_abort'}){super('controlled');this.diagnostics=diagnostics;this.transient=diagnostics.httpStatus>=500||diagnostics.failureCode==='transport';}}export class OpenRouter{constructor(key,model,input,output,transport){if(key!=='synthetic'||input!==.5||output!==.9)throw Error('Policy changed');this.model=model;this.transport=transport;fs.writeFileSync('constructed','yes');}async generate(q){fs.appendFileSync('generations','1');if(q.maxOutputTokens!==4096||q.reasoning!=='high'||!q.requireComplete||!q.stream||q.cacheKey!=='coding:fixture:1:leader')throw Error('Per-call contract changed');if(['http400','http504'].includes(q.messages[0]?.content)){await this.transport('data:application/json,{}');throw new ModelError({failureCode:'provider',httpStatus:Number(q.messages[0].content.slice(4))});}if(['incomplete','transport'].includes(q.messages[0]?.content)){await this.transport('data:application/json,{}');throw new ModelError({failureCode:q.messages[0].content,...(q.messages[0].content==='incomplete'?{finishReason:'length'}:{})});}if(q.messages[0]?.content==='wait'){await this.transport('data:application/json,{}');process.stderr.write('started\\n');await new Promise((resolve,reject)=>{if(q.signal.aborted)reject(new ModelError());else q.signal.addEventListener('abort',()=>reject(new ModelError()),{once:true});});}await q.onProgress({bytes:37,provider:'synthetic',responseId:'controlled'});return {message:{role:'assistant',content:'Controlled summary'},model:this.model,usage:{cost:0}};}}`,
  );
  return {
    root,
    run: (body, cancel = false) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", helper],
          { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
        );
        let output = "";
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("Helper did not terminate"));
        }, 5000);
        child.stdout.on("data", (data) => (output += data));
        child.stderr.on("data", (data) => {
          if (cancel && String(data).includes("started")) child.stdin.end();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timeout);
          try {
            resolve({
              code,
              result: output.trim().split("\n").map(JSON.parse).at(-1).value,
              frames: output.trim().split("\n").map(JSON.parse),
            });
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.write(JSON.stringify(body) + "\n");
      }),
  };
}
test("provider helper forwards native summary allowance and existing policy", async (t) => {
  const f = await fixture(t),
    r = await f.run(input);
  assert.equal(r.code, 0);
  assert.equal(r.frames[0].type, "progress");
  assert.equal(r.frames[0].value.bytes, 37);
  assert.equal(r.result.accounting.requestedOutputTokens, 4096);
  assert.equal(r.result.accounting.purpose, "compaction");
});
test("provider helper aborts dispatched work on cancellation-channel EOF", async (t) => {
  const f = await fixture(t),
    r = await f.run(
      { ...input, messages: [{ role: "user", content: "wait" }] },
      true,
    );
  assert.equal(r.code, 1);
  assert.equal(r.result.failed, true);
  assert.equal(r.result.diagnostics.failureCode, "controlled_abort");
  assert.equal(r.result.dispatchAttempted, true);
  assert.equal(r.result.outcomeKnown, false);
  assert.equal(r.result.billingUnknown, true);
});
test("provider helper rejects unselected models before constructing a provider", async (t) => {
  const f = await fixture(t),
    r = await f.run({ ...input, model: "unselected/model" });
  assert.equal(r.code, 1);
  await assert.rejects(access(join(f.root, "constructed")));
});

for (const failure of ["incomplete", "transport"]) {
  test(`provider helper separates ${failure} outcome from missing billing`, async (t) => {
    const f = await fixture(t),
      r = await f.run({
        ...input,
        messages: [{ role: "user", content: failure }],
      });
    assert.equal(r.code, 1);
    assert.equal(r.result.dispatchAttempted, true);
    assert.equal(r.result.billingUnknown, true);
    assert.equal(r.result.outcomeKnown, failure === "incomplete");
    assert.equal(r.result.diagnostics.failureCode, failure);
  });
}

for (const status of [400, 504]) {
  test(`provider helper retains HTTP ${status} transience without retrying`, async (t) => {
    const f = await fixture(t);
    const r = await f.run({
      ...input,
      messages: [{ role: "user", content: `http${status}` }],
    });
    assert.equal(r.code, 1);
    assert.equal(r.result.diagnostics.httpStatus, status);
    assert.equal(r.result.transient, status === 504);
    assert.equal(r.result.outcomeKnown, true);
    assert.equal(r.result.billingUnknown, true);
    assert.equal(r.frames.length, 1);
    assert.equal(await readFile(join(f.root, "generations"), "utf8"), "1");
  });
}
