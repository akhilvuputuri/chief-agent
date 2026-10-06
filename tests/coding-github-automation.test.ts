import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GitHubAutomation } from "../src/coding/github-automation.js";
import type { MergeTarget } from "../src/coding/merge-policy.js";
const repo = "akhilvuputuri/chief-agent",
  head = "b".repeat(40),
  base = "a".repeat(40),
  tree = "c".repeat(40),
  merged = "d".repeat(40);
function fixture() {
  const t: MergeTarget = {
    id: randomUUID(),
    revision: 2,
    baseSha: base,
    head,
    tree,
    url: `https://github.com/${repo}/pull/9`,
  };
  const pr: any = {
    node_id: "PR_fixture",
    user: { login: "chief-coding-publisher[bot]" },
    head: {
      sha: head,
      ref: `chief/coding-${t.id}-r1`,
      repo: { full_name: repo },
    },
    base: { sha: base, ref: "main", repo: { full_name: repo } },
    draft: true,
    state: "open",
    merged: false,
    mergeable: true,
  };
  const ci: any = {
    id: 10,
    head_sha: head,
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  const devin: any = {
    context: "Devin Review",
    state: "success",
    creator: { login: "devin-ai-integration[bot]", type: "Bot" },
    target_url: `https://app.devin.ai/review/${repo}/pull/9`,
  };
  const comments: any[] = [],
    inline: any[] = [],
    reviews: any[] = [],
    writes: any[] = [];
  let statuses: any[] = [devin],
    runs: any[] = [ci];
  const api = async (path: string, method?: string, body?: any) => {
    if (method === "POST" || method === "PUT") {
      writes.push({ path, body });
      return path.endsWith("/merge") ? { merged: true, sha: merged } : {};
    }
    if (path === "pulls/9") return pr;
    if (path === "git/ref/heads/main") return { object: { sha: base } };
    if (path.startsWith("git/commits/")) return { tree: { sha: tree } };
    if (path.startsWith("actions/runs?"))
      return { total_count: runs.length, workflow_runs: runs };
    if (path.startsWith(`commits/${head}/statuses`)) return statuses;
    if (path === "issues/9/comments?per_page=100") return comments;
    if (path === "pulls/9/comments?per_page=100") return inline;
    if (path === "pulls/9/reviews?per_page=100") return reviews;
    if (path.includes("/jobs?"))
      return {
        total_count: 1,
        jobs: [{ id: 111, name: "test", conclusion: ci.conclusion, steps: [] }],
      };
    throw Error("Unexpected fixture request " + path);
  };
  const graph = async () => {
    writes.push({ ready: true });
    return {
      markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
    };
  };
  const gh = new GitHubAutomation(repo, api, graph);
  return {
    t,
    pr,
    ci,
    devin,
    comments,
    inline,
    reviews,
    writes,
    gh,
    setStatuses: (s: any[]) => (statuses = s),
    setRuns: (r: any[]) => (runs = r),
  };
}
test("only exact trusted CI and Devin status pass, and unresolved MR feedback is collected privately", async () => {
  const f = fixture();
  f.inline.push({
    id: 1,
    updated_at: "x",
    user: { login: "reviewer" },
    body: "PRIVATE source finding",
    path: "src/fixture.ts",
    line: 1,
  });
  const r = await f.gh.inspect(f.t);
  assert.equal(r.checks, "passed");
  assert.equal(r.feedback.length, 1);
  assert.match(r.feedback[0].text, /PRIVATE source finding/);
  await f.gh.attest(f.t, "fixture/reviewer", "a".repeat(64), [
    r.feedback[0].id,
  ]);
  assert(!JSON.stringify(f.writes).includes("PRIVATE"));
});
test("missing Devin and newer failed attempts cannot fall back to old successes", async () => {
  const f = fixture();
  f.setStatuses([]);
  assert.equal((await f.gh.inspect(f.t)).checks, "pending");
  f.setStatuses([{ ...f.devin, state: "failure" }, f.devin]);
  assert.equal((await f.gh.inspect(f.t)).checks, "failed");
  f.setStatuses([f.devin]);
  f.setRuns([{ ...f.ci, id: 11, conclusion: "failure" }, f.ci]);
  assert.equal((await f.gh.inspect(f.t)).checks, "failed");
});
test("forged status publisher or wrong repository workflow cannot authorize merge", async () => {
  const f = fixture();
  f.setStatuses([{ ...f.devin, creator: { login: "owner", type: "User" } }]);
  await assert.rejects(f.gh.inspect(f.t), /Untrusted/);
  f.setStatuses([f.devin]);
  f.setRuns([{ ...f.ci, path: ".github/workflows/not-ci.yml" }]);
  assert.equal((await f.gh.inspect(f.t)).checks, "pending");
});
test("comments edited after a prior review get a new feedback identity; oversized comments are not silently discarded", async () => {
  const f = fixture();
  f.comments.push({
    id: 1,
    body: "Fix case A",
    updated_at: "first",
    user: { login: "owner" },
  });
  const first = (await f.gh.inspect(f.t)).feedback[0].id;
  f.comments[0].body = "Fix case B";
  assert.notEqual((await f.gh.inspect(f.t)).feedback[0].id, first);
  f.comments[0].body = "x".repeat(8000);
  await assert.rejects(f.gh.inspect(f.t), /bounds/);
});
test("a spoofed attestation comment is feedback and cannot suppress the real host record", async () => {
  const f = fixture();
  f.comments.push({
    id: 1,
    body: `Chief review attestation: ${head}`,
    updated_at: "now",
    user: { login: "someone" },
  });
  assert.equal((await f.gh.inspect(f.t)).feedback.length, 1);
  await f.gh.attest(f.t, "fixture/reviewer", "a".repeat(64));
  assert.equal(f.writes.length, 1);
});
test("merge is fenced to the recorded head, marks the owned draft ready and never bypasses repository rules", async () => {
  const f = fixture();
  const result = await f.gh.merge(f.t);
  assert.equal(result.sha, merged);
  assert.deepEqual(f.writes.at(-1).body, { sha: head, merge_method: "merge" });
  const changed = fixture();
  changed.pr.head.sha = "e".repeat(40);
  await assert.rejects(changed.gh.merge(changed.t), /changed/);
  assert.equal(changed.writes.length, 0);
  const foreign = fixture();
  foreign.pr.head.repo.full_name = "other/repo";
  await assert.rejects(foreign.gh.merge(foreign.t), /ownership/);
  assert.equal(foreign.writes.length, 0);
});
test("merge reconciliation verifies the same head and returns the existing merge without a second write", async () => {
  const f = fixture();
  f.pr.merged = true;
  f.pr.merge_commit_sha = merged;
  assert.deepEqual(await f.gh.merge(f.t), { sha: merged });
  assert.equal(f.writes.length, 0);
  f.pr.head.sha = "e".repeat(40);
  await assert.rejects(f.gh.merge(f.t), /Different head/);
});
