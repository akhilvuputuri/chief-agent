import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const repo = "akhilvuputuri/companion-agent";
export function releaseStatus(sha, statuses, run, jobs = []) {
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Use a full 40-character commit SHA");
  if (!Array.isArray(statuses))
    throw new Error("Invalid GitHub status response");
  const unknown = (message) => ({
    sha,
    state: "unverified",
    exitCode: 2,
    message,
  });
  // API returns newest first; never fall through a failed retry to an old success.
  const receipt = statuses.find((s) => s.context === "companion/production");
  if (!receipt)
    return unknown(
      "No deployment receipt. Inspect exact release logs; merge/checks alone are insufficient.",
    );
  const match =
    /^https:\/\/github\.com\/akhilvuputuri\/companion-agent\/actions\/runs\/(\d+)$/.exec(
      receipt.target_url ?? "",
    );
  if (
    !match ||
    receipt.creator?.login !== "github-actions[bot]" ||
    receipt.creator?.type !== "Bot"
  )
    return unknown("Untrusted deployment receipt publisher or workflow URL.");
  if (
    !run ||
    String(run.id) !== match[1] ||
    run.path !== ".github/workflows/deploy.yml" ||
    run.repository?.full_name !== repo ||
    run.head_repository?.full_name !== repo ||
    run.head_sha !== sha ||
    run.head_branch !== "main" ||
    !["workflow_run", "workflow_dispatch"].includes(run.event)
  )
    return unknown(
      "Receipt is not bound to the expected release workflow and exact main commit. Inspect release logs.",
    );
  if (!["success", "failure", "error", "pending"].includes(receipt.state))
    return unknown("Invalid deployment receipt state.");
  const inProgress = run.status !== "completed";
  const deploy = jobs.find((j) => j.name === "deploy" && j.run_id === run.id);
  // Query jobs for the current run attempt, not an earlier successful attempt.
  const succeeded =
    receipt.state === "success" &&
    run.conclusion === "success" &&
    deploy?.status === "completed" &&
    deploy?.conclusion === "success";
  const state = inProgress ? "pending" : succeeded ? "success" : "failure";
  return {
    sha,
    state,
    exitCode: state === "success" ? 0 : state === "pending" ? 2 : 1,
    workflow: receipt.target_url,
    recordedAt: receipt.created_at,
    message:
      state === "success"
        ? "Exact commit deployed and startup health passed at release time; this is not a current health or feature acceptance check."
        : "Deployment not verified by this attempt. Read release logs and production diagnostics.",
  };
}
function api(path) {
  return JSON.parse(
    execFileSync("gh", ["api", "--paginate", "--slurp", path], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [sha, ...extra] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/.test(sha ?? "") || extra.length)
      throw new Error("Usage: npm run release:status -- FULL_COMMIT_SHA");
    const statuses = api(
      `repos/${repo}/commits/${sha}/statuses?per_page=100`,
    ).flat();
    const receipt = statuses.find((s) => s.context === "companion/production");
    const match =
      /^https:\/\/github\.com\/akhilvuputuri\/companion-agent\/actions\/runs\/(\d+)$/.exec(
        receipt?.target_url ?? "",
      );
    let run, jobs;
    if (
      match &&
      receipt.creator?.login === "github-actions[bot]" &&
      receipt.creator?.type === "Bot"
    ) {
      [run] = api(`repos/${repo}/actions/runs/${match[1]}`);
      if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
        throw new Error("Invalid release attempt");
      jobs = api(
        `repos/${repo}/actions/runs/${match[1]}/attempts/${run.run_attempt}/jobs?per_page=100`,
      ).flatMap((p) => p.jobs);
    }
    const result = releaseStatus(sha, statuses, run, jobs);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
  } catch (error) {
    // Child-process errors may contain authentication output; never echo it.
    console.error(
      error?.status !== undefined || error?.code
        ? "Unable to read GitHub deployment evidence; check GitHub authentication, network and Actions/repository access."
        : error.message,
    );
    process.exitCode = 1;
  }
}
