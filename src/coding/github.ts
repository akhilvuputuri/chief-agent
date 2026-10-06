import { GitHubAutomation } from "./github-automation.js";
import { createHash, createSign } from "node:crypto";
import type { Checkpoint, Outcome } from "./schema.js";

export function canonicalJson(value: unknown): string {
  const normalized = JSON.parse(JSON.stringify(value));
  const order = (v: any): any =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, order(x)]),
          )
        : v;
  return JSON.stringify(order(normalized));
}

export function artifactHash(c: Checkpoint) {
  return createHash("sha256")
    .update(
      canonicalJson({
        patch: c.patch,
        files: [...c.files].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      }),
    )
    .digest("hex");
}
export function validateFiles(files: Checkpoint["files"]) {
  const paths = new Set<string>();
  for (const f of files) {
    if (
      !/^[A-Za-z0-9_.\-/]+$/.test(f.path) ||
      f.path
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p === ".git") ||
      f.path.startsWith(".github/") ||
      (f.path.split("/").some((p) => p === ".env" || p.startsWith(".env.")) &&
        f.path !== ".env.example") ||
      paths.has(f.path)
    )
      throw new Error(
        "Artifact has an unsafe, duplicate, credential or workflow path",
      );
    paths.add(f.path);
  }
  if (Buffer.byteLength(JSON.stringify(files)) > 500000)
    throw new Error("Artifact exceeds supported size");
}
export interface RepositoryPublisher {
  resolve(): Promise<string>;
  publish(
    job: {
      id: string;
      revision: number;
      base_sha: string;
      objective: string;
      result: Outcome;
      settings: { repository: string; autoMerge?: boolean };
      pr_url?: string;
      head_sha?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ url: string; head: string; tree?: string }>;
  automation?: () => import("./merge-policy.js").PrAutomationRepository;
}

/** The installation credential never crosses the worker boundary. */
export class GitHubPublisher implements RepositoryPublisher {
  private token?: { value: string; expires: number };
  constructor(
    private repository: string,
    private appId: string,
    private installationId: string,
    private privateKey: string,
    private author: { name: string; email: string },
    private transport: typeof fetch = fetch,
    private automationEnabled = false,
  ) {
    if (!author.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author.email))
      throw new Error("Human commit identity must be configured");
  }
  private async credential() {
    if (this.token && this.token.expires > Date.now() + 120000)
      return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }),
    ).toString("base64url");
    const text = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(text);
    const jwt = `${text}.${signer.sign(this.privateKey, "base64url")}`;
    const response = await this.transport(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [this.repository.split("/")[1]],
          permissions: {
            contents: "write",
            pull_requests: "write",
            ...(this.automationEnabled
              ? { checks: "read", actions: "read", statuses: "read" }
              : {}),
          },
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `GitHub installation authentication failed (${response.status})`,
      );
    const data: any = await response.json();
    if (
      typeof data.token !== "string" ||
      !Number.isFinite(Date.parse(data.expires_at))
    )
      throw new Error("Invalid GitHub token response");
    this.token = { value: data.token, expires: Date.parse(data.expires_at) };
    return data.token as string;
  }
  private async api(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const response = await this.transport(
      `https://api.github.com/repos/${this.repository}/${path}`,
      {
        method,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${await this.credential()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw Object.assign(
        new Error(`GitHub repository request failed (${response.status})`),
        { httpStatus: response.status },
      );
    return response.json() as Promise<any>;
  }
  automation() {
    if (!this.automationEnabled) throw new Error("Automatic merge is disabled");
    return new GitHubAutomation(
      this.repository,
      (path, method, body, signal) => this.api(path, method, body, signal),
      async (query, variables) => {
        const response = await this.transport(
          "https://api.github.com/graphql",
          {
            method: "POST",
            signal: AbortSignal.timeout(20000),
            headers: {
              Authorization: `Bearer ${await this.credential()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, variables }),
          },
        );
        if (!response.ok) throw new Error("GitHub readiness request failed");
        const result: any = await response.json();
        if (result.errors?.length || !result.data)
          throw new Error("GitHub readiness acknowledgement uncertain");
        return result.data;
      },
    );
  }
  async resolve() {
    const ref = await this.api("git/ref/heads/main");
    if (!/^[a-f0-9]{40}$/.test(ref.object?.sha))
      throw new Error("Main commit unavailable");
    return ref.object.sha as string;
  }
  async publish(
    j: Parameters<RepositoryPublisher["publish"]>[0],
    signal?: AbortSignal,
  ) {
    if (j.settings.repository !== this.repository)
      throw new Error("Repository not allowed");
    validateFiles(j.result.checkpoint.files);
    let branch = `chief/coding-${j.id}-r${j.revision}`;
    let continuation: any;
    if (j.pr_url) {
      const prefix = `https://github.com/${this.repository}/pull/`;
      if (
        !j.pr_url.startsWith(prefix) ||
        !/^[1-9][0-9]*$/.test(j.pr_url.slice(prefix.length)) ||
        !/^[a-f0-9]{40}$/.test(j.head_sha ?? "")
      )
        throw new Error("Invalid PR continuation");
      continuation = await this.api(`pulls/${j.pr_url.slice(prefix.length)}`);
      if (
        continuation.state !== "open" ||
        continuation.head?.repo?.full_name !== this.repository ||
        continuation.base?.repo?.full_name !== this.repository ||
        continuation.base?.ref !== "main" ||
        continuation.base.sha !== j.base_sha ||
        !new RegExp(`^chief/coding-${j.id}-r[1-9][0-9]*$`).test(
          continuation.head?.ref ?? "",
        )
      )
        throw new Error("PR continuation identity changed");
      branch = continuation.head.ref;
    }
    const existing = continuation
      ? []
      : await this.api(
          `pulls?state=all&head=${encodeURIComponent(this.repository.split("/")[0] + ":" + branch)}&base=main`,
          "GET",
          undefined,
          signal,
        );
    if (existing.length) {
      if (
        existing.length !== 1 ||
        existing[0].state !== "open" ||
        existing[0].draft !== true
      )
        throw new Error("Existing coding PR needs operator inspection");
    }
    const commit = await this.api(
      `git/commits/${j.base_sha}`,
      "GET",
      undefined,
      signal,
    );
    const baseTree = await this.api(
      `git/trees/${commit.tree.sha}?recursive=1`,
      "GET",
      undefined,
      signal,
    );
    if (baseTree.truncated)
      throw new Error("Repository tree exceeds supported size");
    const tree = [];
    for (const file of j.result.checkpoint.files) {
      const prior = baseTree.tree.find((p: any) => p.path === file.path);
      if (prior && prior.mode !== "100644" && prior.mode !== "100755")
        throw new Error("Only regular files may be changed");
      if (file.content === null && !prior)
        throw new Error("Cannot delete an absent file");
      tree.push({
        path: file.path,
        mode: file.mode ?? prior?.mode ?? "100644",
        type: "blob",
        ...(file.content === null ? { sha: null } : { content: file.content }),
      });
    }
    if (!tree.length) throw new Error("Candidate has no changes");
    const newTree = await this.api(
      "git/trees",
      "POST",
      { base_tree: commit.tree.sha, tree },
      signal,
    );
    if (continuation && continuation.head.sha === j.head_sha) {
      const current = await this.api(`git/commits/${j.head_sha}`);
      if (current.tree?.sha === newTree.sha)
        return {
          url: j.pr_url!,
          head: j.head_sha!,
          tree: newTree.sha as string,
        };
    }
    if (continuation && continuation.head.sha !== j.head_sha) {
      const current = await this.api(`git/commits/${continuation.head.sha}`);
      if (
        current.tree?.sha !== newTree.sha ||
        current.parents?.length !== 1 ||
        current.parents[0].sha !== j.head_sha
      )
        throw new Error("PR continuation was changed externally");
      return {
        url: j.pr_url!,
        head: continuation.head.sha as string,
        tree: newTree.sha as string,
      };
    }
    if (existing.length) {
      const head = await this.api(
        `git/commits/${existing[0].head.sha}`,
        "GET",
        undefined,
        signal,
      );
      if (
        head.tree.sha !== newTree.sha ||
        head.parents?.length !== 1 ||
        head.parents[0].sha !== j.base_sha ||
        existing[0].base.repo.full_name !== this.repository ||
        existing[0].head.repo.full_name !== this.repository
      )
        throw new Error(
          "Existing PR no longer matches the coding artifact; operator inspection required",
        );
      return {
        url: String(existing[0].html_url),
        head: String(existing[0].head.sha),
        tree: String(newTree.sha),
      };
    }
    const newCommit = await this.api(
      "git/commits",
      "POST",
      {
        message: `Coding job ${j.id}: proposed change`,
        tree: newTree.sha,
        parents: [continuation ? j.head_sha : j.base_sha],
        author: this.author,
        committer: this.author,
        // Commit identity is the human repository owner, configured by the operator.
      },
      signal,
    );
    if (continuation) {
      try {
        await this.api(
          `git/refs/heads/${branch}`,
          "PATCH",
          { sha: newCommit.sha, force: false },
          signal,
        );
      } catch {
        const ref = await this.api(`git/ref/heads/${branch}`);
        if (ref.object?.sha !== newCommit.sha)
          throw new Error("PR update uncertain; reconcile before retry");
      }
      const latest = await this.api(`pulls/${j.pr_url!.split("/").at(-1)}`);
      if (latest.head?.sha !== newCommit.sha)
        throw new Error("PR update identity unavailable");
      return {
        url: j.pr_url!,
        head: newCommit.sha as string,
        tree: newTree.sha as string,
      };
    }
    // No force update. Reconcile a lost create-ref acknowledgement against the exact tree.
    try {
      await this.api(
        "git/refs",
        "POST",
        { ref: `refs/heads/${branch}`, sha: newCommit.sha },
        signal,
      );
    } catch (error) {
      const ref = await this.api(
        `git/ref/heads/${branch}`,
        "GET",
        undefined,
        signal,
      );
      const found = await this.api(
        `git/commits/${ref.object.sha}`,
        "GET",
        undefined,
        signal,
      );
      if (
        found.tree.sha !== newTree.sha ||
        found.parents?.[0]?.sha !== j.base_sha
      )
        throw error;
      newCommit.sha = ref.object.sha;
    }
    const pr = await this.api(
      "pulls",
      "POST",
      {
        title: `Chief coding job ${j.id.slice(0, 8)}`,
        head: branch,
        base: "main",
        draft: true,
        body: `Prepared by Chief's isolated coding runtime.\n\nBase: \`${j.base_sha}\`\nArtifact: \`${artifactHash(j.result.checkpoint)}\`\n\nSandbox checks: ${j.result.checks.map((c) => `${c.command}: exit ${c.exitCode}`).join(", ")}.\n\nSandbox review: ${j.result.review?.verdict ?? "unavailable"} (${j.result.review?.model ?? "unknown"}). ${j.settings.autoMerge ? "Chief binds this independent squad review to the verified published Git tree and exact head; CI and MR feedback remain merge gates. There is no additional final review when the candidate is unchanged." : "This is a worker report; independent review of the published head and CI are still required."}\n\nPrivate request, traces and command output are retained outside this public PR.`,
      },
      signal,
    );
    if (
      !/^https:\/\/github\.com\//.test(pr.html_url) ||
      pr.head.sha !== newCommit.sha
    )
      throw new Error("Published PR identity unavailable");
    return {
      url: pr.html_url as string,
      head: newCommit.sha as string,
      tree: newTree.sha as string,
    };
  }
}
