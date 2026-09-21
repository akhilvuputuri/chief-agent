import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseStatus } from "./release-status.mjs";
const sha = "a".repeat(40);
const receipt = (state) => ({
  context: "companion/production",
  state,
  target_url:
    "https://github.com/akhilvuputuri/companion-agent/actions/runs/123",
  created_at: "2026-09-22T00:00:00Z",
});
test("CI success alone is not production evidence", () => {
  assert.equal(
    releaseStatus(sha, [{ ...receipt("success"), context: "checks" }]).exitCode,
    2,
  );
});
test("latest failed or pending attempt supersedes older success", () => {
  assert.equal(
    releaseStatus(sha, [receipt("failure"), receipt("success")]).exitCode,
    1,
  );
  assert.equal(
    releaseStatus(sha, [receipt("pending"), receipt("success")]).exitCode,
    2,
  );
  assert.equal(releaseStatus(sha, [receipt("success")]).exitCode, 0);
});
test("reject ambiguous identities and invalid evidence", () => {
  assert.throws(() => releaseStatus("main", []));
  assert.throws(() => releaseStatus(sha, {}));
  assert.throws(() =>
    releaseStatus(sha, [
      { ...receipt("success"), target_url: "https://example.com" },
    ]),
  );
  assert.throws(() => releaseStatus(sha, [receipt("unknown")]));
});
