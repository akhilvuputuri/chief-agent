import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
// Execute the actual, JS-compatible GitHub expression, not a duplicate policy.
const workflow = readFileSync(
  new URL("../.github/workflows/diagnostics.yml", import.meta.url),
  "utf8",
);
const expression = workflow
  .match(/    if: >-\n([\s\S]*?)    runs-on:/)[1]
  .trim();
const allowed = new Function("github", `return (${expression});`);
const user = { id: 158243242, login: "devin-ai-integration[bot]", type: "Bot" };
const request = () => ({
  repository: "akhilvuputuri/companion-agent",
  repository_owner: "akhilvuputuri",
  ref: "refs/heads/main",
  actor: user.login,
  event_name: "issue_comment",
  event: {
    repository: { id: 1358822022, private: true },
    comment: { body: "/companion diagnose", user: { ...user } },
  },
});
test("diagnostics permits only fixed owner/Devin requests and manual main dispatch", () => {
  assert.equal(allowed(request()), true);
  const renamed = request();
  renamed.repository = "akhilvuputuri/chief-agent";
  assert.equal(allowed(renamed), true);
  const owner = request();
  owner.actor = "akhilvuputuri";
  owner.event.comment.user = { login: owner.actor, type: "User" };
  assert.equal(allowed(owner), true);
  const manual = request();
  manual.event_name = "workflow_dispatch";
  delete manual.event.comment;
  assert.equal(allowed(manual), true);
});
test("diagnostics rejects other actors, impersonation, arguments, public repos and other refs", () => {
  const mutations = [
    (x) => {
      x.event.repository.id = 1;
    },
    (x) => {
      x.actor = "outsider";
      x.event.comment.user = { login: "outsider", type: "User" };
    },
    (x) => {
      x.event.comment.user.id = 1;
    },
    (x) => {
      x.event.comment.user.type = "User";
    },
    (x) => {
      x.actor = "different-actor";
    },
    (x) => {
      x.event.comment.body += " main";
    },
    (x) => {
      x.event.comment.body += "\n/companion deploy";
    },
    (x) => {
      x.event.repository.private = false;
    },
    (x) => {
      x.ref = "refs/heads/untrusted";
    },
    (x) => {
      x.repository = "fork/companion-agent";
    },
    (x) => {
      x.event_name = "pull_request";
    },
  ];
  for (const mutate of mutations) {
    const input = request();
    mutate(input);
    assert.equal(allowed(input), false);
  }
  assert.match(workflow, /types: \[created\]/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});
