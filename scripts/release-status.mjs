import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function releaseStatus(sha, statuses) {
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Use a full 40-character commit SHA");
  if (!Array.isArray(statuses))
    throw new Error("Invalid GitHub status response");
  // The API returns newest first, including pending/failed retries after success.
  const receipt = statuses.find((s) => s.context === "companion/production");
  if (!receipt)
    return {
      sha,
      state: "unverified",
      exitCode: 2,
      message:
        "No deployment receipt. Inspect exact release logs; merge/checks alone are insufficient.",
    };
  const validUrl =
    /^https:\/\/github\.com\/akhilvuputuri\/companion-agent\/actions\/runs\/\d+$/.test(
      receipt.target_url ?? "",
    );
  if (!validUrl) throw new Error("Invalid production receipt workflow URL");
  const state = receipt.state;
  if (!["success", "failure", "error", "pending"].includes(state))
    throw new Error("Invalid production receipt state");
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [sha, ...extra] = process.argv.slice(2);
    if (!/^[a-f0-9]{40}$/.test(sha ?? "") || extra.length)
      throw new Error("Usage: npm run release:status -- FULL_COMMIT_SHA");
    const pages = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/akhilvuputuri/companion-agent/commits/${sha}/statuses?per_page=100`,
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    const result = releaseStatus(sha, pages.flat());
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
