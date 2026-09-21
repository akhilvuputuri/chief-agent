import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseStatus } from "./release-status.mjs";
const sha = "a".repeat(40);
const repository = { full_name: "akhilvuputuri/companion-agent" };
const run = {
  id: 123,
  path: ".github/workflows/deploy.yml",
  repository,
  head_repository: repository,
  head_sha: sha,
  head_branch: "main",
  event: "workflow_run",
  status: "completed",
  conclusion: "success",
};
const jobs = [
  { name: "deploy", run_id: 123, status: "completed", conclusion: "success" },
];
const receipt = (state) => ({
  context: "companion/production",
  creator: { login: "github-actions[bot]", type: "Bot" },
  state,
  target_url:
    "https://github.com/akhilvuputuri/companion-agent/actions/runs/123",
  created_at: "2026-09-22T00:00:00Z",
});
test("CI success alone is not production evidence", () => {
  assert.equal(
    releaseStatus(
      sha,
      [{ ...receipt("success"), context: "checks" }],
      run,
      jobs,
    ).exitCode,
    2,
  );
});
test("latest failed or pending attempt cannot reuse older success", () => {
  assert.equal(
    releaseStatus(sha, [receipt("failure"), receipt("success")], run, jobs)
      .exitCode,
    1,
  );
  assert.equal(
    releaseStatus(
      sha,
      [receipt("pending"), receipt("success")],
      { ...run, status: "in_progress" },
      jobs,
    ).exitCode,
    2,
  );
  assert.equal(releaseStatus(sha, [receipt("success")], run, jobs).exitCode, 0);
});
test("reject ambiguous identities and spoofed evidence", () => {
  assert.throws(() => releaseStatus("main", []));
  assert.throws(() => releaseStatus(sha, {}));
  for (const change of [
    { target_url: "https://example.com" },
    { creator: { login: "external-ci[bot]", type: "Bot" } },
    { state: "unknown" },
  ])
    assert.equal(
      releaseStatus(sha, [{ ...receipt("success"), ...change }], run, jobs)
        .exitCode,
      2,
    );
});
test("requires expected workflow, repo, branch, event and exact commit", () => {
  for (const change of [
    { id: 456 },
    { path: ".github/workflows/ci.yml" },
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { event: "pull_request" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "other/repo" } },
  ])
    assert.equal(
      releaseStatus(sha, [receipt("success")], { ...run, ...change }, jobs)
        .exitCode,
      2,
    );
  assert.equal(releaseStatus(sha, [receipt("success")]).exitCode, 2);
});
test("success receipt alone cannot establish deployment when run or deploy failed", () => {
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    assert.equal(
      releaseStatus(sha, [receipt("success")], { ...run, conclusion }, jobs)
        .exitCode,
      1,
    );
    assert.equal(
      releaseStatus(sha, [receipt("success")], run, [
        { ...jobs[0], conclusion },
      ]).exitCode,
      1,
    );
  }
  assert.equal(releaseStatus(sha, [receipt("success")], run, []).exitCode, 1);
  assert.equal(
    releaseStatus(
      sha,
      [receipt("success")],
      { ...run, status: "in_progress" },
      jobs,
    ).exitCode,
    2,
  );
});
