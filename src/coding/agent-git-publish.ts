import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Execute = (
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutput?: number,
) => Promise<{ exitCode: number | null; output: string; truncated?: boolean }>;

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/**
 * Publishes exactly the approved files as one commit on the pinned base. The commit is
 * built in a fresh repository from the approved contents, so nothing the model controls
 * (workspace git configuration, filters, hooks or its own commit history) can change
 * what is pushed or capture the token.
 */
export async function publishSandboxBranch(input: {
  execute: Execute;
  signal: AbortSignal;
  scratch: string;
  repository: string;
  branch: string;
  base: string;
  author: { name: string; email: string };
  title: string;
  body: string;
  files: { path: string; content: string | null; mode?: string }[];
  token: () => Promise<string>;
  remote?: string;
  /** Where the pinned base commit is fetched from; never the model's workspace. */
  baseSource?: string;
  api?: typeof fetch;
}): Promise<{ url: string; head: string }> {
  if (!/^chief\/coding-[0-9a-f-]{36}$/.test(input.branch))
    throw new Error("Agent branch must be the job's chief/coding branch");
  if (!/^[a-f0-9]{40}$/.test(input.base))
    throw new Error("Agent publication needs the pinned base");
  if (!input.files.length) throw new Error("Agent publication has no changes");
  // Errors name the step, never the command: the push command carries the credential.
  const run = async (command: string, step: string) => {
    const result = await input.execute(command, input.signal, 120000, 200000);
    if (result.exitCode !== 0 || result.truncated)
      throw new Error(`Agent git publication failed at ${step}`);
    return result.output;
  };
  const clean = await mkdtemp(join(input.scratch, "agent-push-"));
  const blobs = await mkdtemp(join(input.scratch, "agent-blobs-"));
  const index = join(clean, "approved.index");
  const git = `env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_INDEX_FILE=${quote(index)} git -c core.hooksPath=/dev/null -C ${quote(clean)}`;
  await run(`${git} init -q`, "init");
  const source =
    input.baseSource ?? `https://github.com/${input.repository}.git`;
  await run(
    `${git} fetch -q --depth=1 --no-tags ${quote(source)} ${input.base}`,
    "fetch base",
  );
  await run(`${git} cat-file -e ${input.base}^{commit}`, "check base");
  await run(`${git} read-tree ${input.base}`, "read base tree");
  for (const [n, file] of input.files.entries()) {
    if (
      file.path.startsWith("/") ||
      file.path.split("/").some((p) => p === ".." || p === ".git" || !p)
    )
      throw new Error("Approved file path is invalid");
    if (file.content === null) {
      await run(
        `${git} update-index --force-remove -- ${quote(file.path)}`,
        "remove file",
      );
      continue;
    }
    const blobPath = join(blobs, String(n));
    await writeFile(blobPath, file.content, { mode: 0o600 });
    const blob = (
      await run(
        `${git} hash-object -w --no-filters ${quote(blobPath)}`,
        "write blob",
      )
    ).trim();
    const prior = (
      await run(
        `${git} ls-tree ${input.base} -- ${quote(file.path)}`,
        "read file mode",
      )
    ).split(" ")[0];
    const mode =
      file.mode ??
      (prior === "100755" || prior === "100644" ? prior : "100644");
    if (mode !== "100644" && mode !== "100755")
      throw new Error("Only regular files may be published");
    await run(
      `${git} update-index --add --cacheinfo ${mode},${blob},${quote(file.path)}`,
      "stage file",
    );
  }
  const tree = (await run(`${git} write-tree`, "write tree")).trim();
  const identity = `GIT_AUTHOR_NAME=${quote(input.author.name)} GIT_AUTHOR_EMAIL=${quote(input.author.email)} GIT_COMMITTER_NAME=${quote(input.author.name)} GIT_COMMITTER_EMAIL=${quote(input.author.email)}`;
  const head = (
    await run(
      `env ${identity} ${git} commit-tree ${tree} -p ${input.base} -m ${quote(input.title)}`,
      "commit",
    )
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(head))
    throw new Error("Approved commit is invalid");
  // The credential is requested only for the push of this constructed commit.
  const token = await input.token();
  const remote = input.remote ?? `https://github.com/${input.repository}.git`;
  const header = Buffer.from(`x-access-token:${token}`).toString("base64");
  await run(
    `${git} -c http.extraheader=${quote(`AUTHORIZATION: basic ${header}`)} push -q --force ${quote(remote)} ${head}:refs/heads/${input.branch}`,
    "push",
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
