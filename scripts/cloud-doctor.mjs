// Read-only capability check. Never prints authentication output or credentials.
import { execFileSync } from "node:child_process";
function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}
const major = Number(process.versions.node.split(".")[0]);
const result = {
  node22OrLater: major >= 22,
  git: run("git", ["--version"]) !== null,
  githubCli: run("gh", ["--version"]) !== null,
  repositoryRead: false,
  repositoryWrite: false,
  actionsRead: false,
  workflowDispatch: "not tested (would mutate)",
  productionSecrets: "not required; must stay outside cloud task",
};
const repo = run("gh", ["api", "repos/akhilvuputuri/companion-agent"]);
if (repo) {
  try {
    const r = JSON.parse(repo);
    result.repositoryRead = true;
    result.repositoryWrite = !!r.permissions?.push;
  } catch {}
}
result.actionsRead =
  run("gh", [
    "api",
    "repos/akhilvuputuri/companion-agent/actions/runs?per_page=1",
  ]) !== null;
console.log(JSON.stringify(result, null, 2));
if (!result.repositoryWrite)
  console.log(
    "Use the cloud PR UI if available. Repository connection alone does not establish merge/API permissions. Report missing merge access rather than claiming a release.",
  );
if (!result.actionsRead)
  console.log(
    "Workflow logs need GitHub Actions read access. Ask for an incident screenshot/time if production evidence is unavailable.",
  );
