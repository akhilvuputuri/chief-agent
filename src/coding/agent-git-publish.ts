import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

type Execute = (
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutput?: number,
) => Promise<{ exitCode: number | null; output: string; truncated?: boolean }>;

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * Commits the approved workspace, then pushes it from a fresh repository the model
 * never touched, so workspace git configuration cannot redirect the token or run hooks.
 */
export async function publishSandboxBranch(input: {
  execute: Execute;
  signal: AbortSignal;
  workspace: string;
  scratch: string;
  repository: string;
  branch: string;
  base: string;
  author: { name: string; email: string };
  title: string;
  body: string;
  /** Called after the commit and before any credential is requested; must throw on mismatch. */
  verify: () => Promise<void>;
  token: () => Promise<string>;
  remote?: string;
  api?: typeof fetch;
}): Promise<{ url: string; head: string }> {
  if (!/^chief\/coding-[0-9a-f-]{36}$/.test(input.branch))
    throw new Error("Agent branch must be the job's chief/coding branch");
  if (!/^[a-f0-9]{40}$/.test(input.base))
    throw new Error("Agent publication needs the pinned base");
  const run = async (command: string, allowFailure = false) => {
    const result = await input.execute(command, input.signal, 120000, 200000);
    if (!allowFailure && (result.exitCode !== 0 || result.truncated))
      throw new Error("Agent git publication step failed");
    return result;
  };
  const git = `git -c core.hooksPath=/dev/null -c user.name=${quote(input.author.name)} -c user.email=${quote(input.author.email)}`;
  await run(`${git} add -A`);
  if ((await run(`${git} diff --cached --quiet`, true)).exitCode !== 0)
    await run(`${git} commit -q --no-verify -m ${quote(input.title)}`);
  await run(`git merge-base --is-ancestor ${input.base} HEAD`);
  const head = (await run("git rev-parse HEAD")).output.trim();
  if (!/^[a-f0-9]{40}$/.test(head))
    throw new Error("Committed head is invalid");
  await input.verify();
  const clean = await mkdtemp(join(input.scratch, "agent-push-"));
  const isolated = `env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.hooksPath=/dev/null -C ${quote(clean)}`;
  await run(`${isolated} init -q`);
  await run(`${isolated} fetch -q --no-tags ${quote(input.workspace)} HEAD`);
  if ((await run(`${isolated} rev-parse FETCH_HEAD`)).output.trim() !== head)
    throw new Error(
      "Isolated push repository differs from the approved commit",
    );
  const token = await input.token();
  const remote = input.remote ?? `https://github.com/${input.repository}.git`;
  const header = Buffer.from(`x-access-token:${token}`).toString("base64");
  await run(
    `${isolated} -c http.extraheader=${quote(`AUTHORIZATION: basic ${header}`)} push -q --force ${quote(remote)} ${head}:refs/heads/${input.branch}`,
  );
  const api = input.api ?? fetch;
  const request = (path: string, init: RequestInit = {}) =>
    api(`https://api.github.com/repos/${input.repository}${path}`, {
      ...init,
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  const owner = input.repository.split("/")[0];
  const open = await request(
    `/pulls?state=open&base=main&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
  );
  if (!open.ok) throw new Error(`Agent PR lookup failed (${open.status})`);
  const existing: any[] = await open.json();
  if (existing.length > 1)
    throw new Error("Multiple agent PRs need inspection");
  if (existing.length === 1) return { url: existing[0].html_url, head };
  const created = await request("/pulls", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      head: input.branch,
      base: "main",
      body: input.body,
      draft: true,
    }),
  });
  if (!created.ok)
    throw new Error(`Agent PR creation failed (${created.status})`);
  const pr: any = await created.json();
  if (typeof pr.html_url !== "string")
    throw new Error("Agent PR response invalid");
  return { url: pr.html_url, head };
}
