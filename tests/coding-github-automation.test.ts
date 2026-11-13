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
  const permissions: Record<string, string> = {
    helper: "write",
    maintainer: "write",
    reader: "read",
  };
  const permissionReads: string[] = [];
  let lookupFailure: number | "network" | undefined;
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
    if (path.startsWith("collaborators/")) {
      permissionReads.push(path);
      const failure = lookupFailure;
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure)
        throw Object.assign(
          new Error(`GitHub repository request failed (${failure})`),
          { httpStatus: failure },
        );
      return { permission: permissions[path.split("/")[1]!] ?? "none" };
    }
    if (path.includes("/jobs?"))
      return {
        total_count: 1,
        jobs: [{ id: 111, name: "test", conclusion: ci.conclusion, steps: [] }],
      };
    throw Error("Unexpected fixture request " + path);
  };
  let threadNodes: any[] = [];
  const graph = async (query: string) => {
    if (query.startsWith("query"))
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: threadNodes,
            },
          },
        },
      };
    writes.push({ ready: true });
    return {
      markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
    };
  };
  const gh = new GitHubAutomation(repo, api, graph);
  return {
    failLookup: (failure: number | "network") => (lookupFailure = failure),
    permissionReads,
    t,
    pr,
    ci,
    devin,
    comments,
    inline,
    reviews,
    writes,
    gh,
    setThreads: (nodes: any[]) => (threadNodes = nodes),
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
test("a Pi PR's rounds are driven only by the owner, collaborators, Devin and CI, and their text is whole (journal 193)", async () => {
  const f = fixture();
  const pi = { ...f.t, trustedFeedback: true };
  f.comments.push(
    {
      id: 1,
      body: "Owner: rename it",
      updated_at: "a",
      author_association: "OWNER",
      user: { login: "akhilvuputuri", type: "User" },
    },
    {
      id: 2,
      body: "Collaborator: " + "y".repeat(20_000),
      updated_at: "a",
      author_association: "COLLABORATOR",
      user: { login: "helper", type: "User" },
    },
    {
      id: 7,
      body: "Reader: read-only collaborator",
      updated_at: "a",
      author_association: "COLLABORATOR",
      user: { login: "reader", type: "User" },
    },
    {
      id: 3,
      body: "Stranger: rewrite everything",
      updated_at: "a",
      author_association: "NONE",
      user: { login: "stranger", type: "User" },
    },
    {
      id: 4,
      body: "Contributor: also this",
      updated_at: "a",
      author_association: "CONTRIBUTOR",
      user: { login: "drive-by", type: "User" },
    },
    {
      id: 5,
      body: "A bot that is not Devin",
      updated_at: "a",
      author_association: "NONE",
      user: { login: "devin-ai-integration[bot]", type: "User" },
    },
    {
      id: 6,
      body: "Devin: the heading level is wrong",
      updated_at: "a",
      author_association: "NONE",
      user: { login: "devin-ai-integration[bot]", type: "Bot" },
    },
  );
  const authors = (await f.gh.inspect(pi)).feedback.map(
    (i: any) => JSON.parse(i.text).comment.split(":")[0],
  );
  assert.deepEqual(authors.sort(), ["Collaborator", "Devin", "Owner"]);
  // Write access is read from GitHub, once per login and inspection; a read-only
  // collaborator drives nothing, and nobody else is looked up.
  assert.deepEqual(f.permissionReads.sort(), [
    "collaborators/helper/permission",
    "collaborators/reader/permission",
  ]);
  const whole = (await f.gh.inspect(pi)).feedback.find((i: any) =>
    i.text.includes("Collaborator"),
  );
  assert.equal(JSON.parse(whole!.text).comment.length, 20_014);
  // The legacy squad still takes every commenter and stops on an oversized item.
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
test("main moving changes the PR's base commit but neither readiness nor the exact-head merge (journal 180)", async () => {
  const f = fixture();
  // GitHub's base.sha follows main; the reviewed head and tree are unchanged.
  f.pr.base.sha = "f".repeat(40);
  await f.gh.ready(f.t);
  assert.deepEqual(f.writes.at(-1), { ready: true });
  f.pr.draft = false;
  const result = await f.gh.merge(f.t);
  assert.equal(result.sha, merged);
  assert.deepEqual(f.writes.at(-1).body, { sha: head, merge_method: "merge" });
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

test("an explicitly reopened thread remains feedback despite old Devin resolved replies", async () => {
  const f = fixture();
  f.inline.push(
    {
      id: 1,
      body: "Required finding",
      updated_at: "2026-10-07T00:00:00Z",
      user: { login: "devin-ai-integration[bot]" },
    },
    {
      id: 2,
      in_reply_to_id: 1,
      body: "✅ **Resolved**: historical",
      created_at: "2026-10-07T00:01:00Z",
      user: { login: "devin-ai-integration[bot]" },
    },
  );
  f.setThreads([
    {
      isResolved: false,
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [{ databaseId: 1 }, { databaseId: 2 }],
      },
    },
  ]);
  let i = await f.gh.inspect(f.t);
  assert.equal(i.feedback.length, 2);
  assert.equal(i.unresolvedThreads, 1);
  f.setThreads([
    {
      isResolved: true,
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [{ databaseId: 1 }, { databaseId: 2 }],
      },
    },
  ]);
  i = await f.gh.inspect(f.t);
  assert.equal(i.feedback.length, 0);
  assert.equal(i.unresolvedThreads, 0);
});

test("Devin's all-clear summary review is not feedback, while its inline findings and human reviews are", async () => {
  const f = fixture();
  f.reviews.push({
    id: 50,
    state: "COMMENTED",
    commit_id: head,
    submitted_at: "2026-10-15T15:17:00Z",
    user: { login: "devin-ai-integration[bot]" },
    body: '## ✅ Devin Review: No Issues Found\n\nDevin Review analyzed this PR and found no bugs or issues to report.\n\n<!-- devin-review-badge-begin -->\n<a href="https://app.devin.ai/review/x">badge</a>',
  });
  let i = await f.gh.inspect(f.t);
  assert.equal(i.feedback.length, 0);
  f.inline.push({
    id: 51,
    updated_at: "2026-10-15T15:18:00Z",
    user: { login: "devin-ai-integration[bot]" },
    body: "Heading level is wrong\n<!-- devin-review-badge-begin -->",
    path: "docs/releases.md",
    line: 3,
  });
  f.reviews.push({
    id: 52,
    state: "CHANGES_REQUESTED",
    commit_id: head,
    submitted_at: "2026-10-15T15:19:00Z",
    user: { login: "akhilvuputuri" },
    body: "Please keep the older entries unchanged",
  });
  i = await f.gh.inspect(f.t);
  assert.equal(i.feedback.length, 2);
  assert.match(JSON.stringify(i.feedback), /Heading level is wrong/);
  assert.match(JSON.stringify(i.feedback), /keep the older entries/);
});

test("a permission lookup that fails ignores only that commenter; the owner's and Devin's comments still count (journal 193)", async () => {
  const { setOpsSink } = await import("../src/ops-log.js");
  for (const failure of [403, 404, "network"] as const) {
    const f = fixture();
    f.failLookup(failure);
    const logs: any[] = [];
    const previous = setOpsSink((line) => logs.push(JSON.parse(line)));
    try {
      f.comments.push(
        {
          id: 1,
          body: "Collaborator: change it",
          updated_at: "a",
          author_association: "COLLABORATOR",
          user: { login: "helper", type: "User" },
        },
        {
          id: 2,
          body: "Owner: rename it",
          updated_at: "a",
          author_association: "OWNER",
          user: { login: "akhilvuputuri", type: "User" },
        },
        {
          id: 3,
          body: "Devin: the heading level is wrong",
          updated_at: "a",
          author_association: "NONE",
          user: { login: "devin-ai-integration[bot]", type: "Bot" },
        },
      );
      const { feedback } = await f.gh.inspect({
        ...f.t,
        trustedFeedback: true,
      });
      assert.deepEqual(
        feedback
          .map((i: any) => JSON.parse(i.text).comment.split(":")[0])
          .sort(),
        ["Devin", "Owner"],
        String(failure),
      );
      const logged = logs.filter(
        (l) => l.event === "coding.pr_permission_unreadable",
      );
      assert.equal(logged.length, 1);
      assert.equal(
        logged[0].httpStatus,
        failure === "network" ? undefined : failure,
      );
      assert(!JSON.stringify(logged).includes("helper"));
    } finally {
      setOpsSink(previous);
    }
  }
});
