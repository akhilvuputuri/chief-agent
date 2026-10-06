import { activeInlineComments } from "./mr-feedback.js";
import { createHash } from "node:crypto";
import { MergeRefused } from "./merge-policy.js";
import type {
  MergeTarget,
  PrAutomationRepository,
  PrInspection,
} from "./merge-policy.js";

type Api = (
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<any>;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const sha = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{40}$/.test(v);

/** GitHub operations remain on Chief, never in the coding sandbox. */
export class GitHubAutomation implements PrAutomationRepository {
  constructor(
    private repository: string,
    private api: Api,
    private graphql: (
      query: string,
      variables: Record<string, unknown>,
    ) => Promise<any>,
  ) {}
  private number(t: MergeTarget) {
    const prefix = `https://github.com/${this.repository}/pull/`;
    if (
      !t.url.startsWith(prefix) ||
      !/^[1-9][0-9]*$/.test(t.url.slice(prefix.length)) ||
      ![t.head, t.baseSha, t.tree].every(sha)
    )
      throw new Error("Invalid owned PR target");
    return Number(t.url.slice(prefix.length));
  }
  private async owned(t: MergeTarget, signal?: AbortSignal) {
    const pr = await this.api(
      `pulls/${this.number(t)}`,
      undefined,
      undefined,
      signal,
    );
    if (
      pr.head?.repo?.full_name !== this.repository ||
      pr.base?.repo?.full_name !== this.repository ||
      pr.base?.ref !== "main" ||
      !new RegExp(`^chief/coding-${t.id}-r[1-9][0-9]*$`).test(
        pr.head?.ref ?? "",
      )
    )
      throw new Error("PR ownership changed");
    return pr;
  }
  async inspect(t: MergeTarget): Promise<PrInspection> {
    const limit = AbortSignal.timeout(120000);
    const api = (path: string) => this.api(path, undefined, undefined, limit);
    const pr = await this.owned(t, limit);
    const main = await api("git/ref/heads/main");
    if (!sha(pr.head.sha)) throw new Error("PR head identity unavailable");
    const commit = await api(`git/commits/${pr.head.sha}`);
    if (!sha(pr.head.sha) || !sha(commit.tree?.sha) || !sha(main.object?.sha))
      throw new Error("PR identity unavailable");
    const result: PrInspection = {
      head: pr.head.sha,
      tree: commit.tree.sha,
      base: pr.base.sha,
      main: main.object.sha,
      merged: pr.merged === true,
      mergeSha: pr.merge_commit_sha,
      closed: pr.state !== "open",
      draft: pr.draft === true,
      mergeable: pr.mergeable,
      checks: "pending",
      feedback: [],
    };
    if (
      result.merged ||
      result.closed ||
      result.head !== t.head ||
      result.tree !== t.tree
    )
      return result;
    const runs = await api(
      `actions/runs?head_sha=${t.head}&event=pull_request&per_page=100`,
    );
    if (!Array.isArray(runs.workflow_runs) || runs.total_count > 100)
      throw new Error("Unbounded check history");
    const ci = runs.workflow_runs
      .filter(
        (r: any) =>
          r.head_sha === t.head &&
          r.head_repository?.full_name === this.repository &&
          r.repository?.full_name === this.repository &&
          r.path === ".github/workflows/ci.yml",
      )
      .sort((a: any, b: any) => b.id - a.id)[0];
    const statuses = await api(`commits/${t.head}/statuses?per_page=100`);
    if (!Array.isArray(statuses) || statuses.length === 100)
      throw new Error("Unbounded status history");
    const devin = statuses.find((s: any) => s.context === "Devin Review");
    if (
      devin &&
      (devin.creator?.login !== "devin-ai-integration[bot]" ||
        devin.creator?.type !== "Bot" ||
        devin.target_url !==
          `https://app.devin.ai/review/${this.repository}/pull/${this.number(t)}`)
    )
      throw new Error("Untrusted Devin status");
    if (
      ci?.status === "completed" &&
      ci.conclusion === "success" &&
      devin?.state === "success"
    )
      result.checks = "passed";
    else if (
      (ci?.status === "completed" && ci.conclusion !== "success") ||
      ["failure", "error"].includes(devin?.state)
    )
      result.checks = "failed";
    const comments = await api(
      `issues/${this.number(t)}/comments?per_page=100`,
    );
    const inline = await api(`pulls/${this.number(t)}/comments?per_page=100`);
    const reviews = await api(`pulls/${this.number(t)}/reviews?per_page=100`);
    if (
      ![comments, inline, reviews].every(
        (a) => Array.isArray(a) && a.length < 100,
      )
    )
      throw new Error("Feedback exceeds inspection bound");
    const [owner, name] = this.repository.split("/");
    const threads = await this.graphql(
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved comments(first:100){pageInfo{hasNextPage}nodes{databaseId}}}}}}}",
      { owner, name, number: this.number(t) },
    );
    const collection = threads.repository?.pullRequest?.reviewThreads;
    if (
      !collection ||
      collection.pageInfo?.hasNextPage ||
      !Array.isArray(collection.nodes) ||
      collection.nodes.some(
        (n: any) =>
          n.comments?.pageInfo?.hasNextPage ||
          !Array.isArray(n.comments?.nodes),
      )
    )
      throw new Error("Review thread state is unavailable or exceeds bounds");
    const resolved = new Set<number>(
      collection.nodes
        .filter((n: any) => n.isResolved === true)
        .flatMap((n: any) => n.comments.nodes.map((c: any) => c.databaseId)),
    );
    for (const c of [
      ...comments,
      ...activeInlineComments(inline, resolved),
      ...reviews.filter(
        (r: any) => r.state !== "PENDING" && r.commit_id === t.head,
      ),
    ]) {
      if (
        typeof c.body !== "string" ||
        !c.body.trim() ||
        (c.user?.login === "chief-coding-publisher[bot]" &&
          (c.body.startsWith("Chief review attestation:") ||
            c.body.startsWith("Chief feedback response:"))) ||
        c.user?.login === "github-actions[bot]"
      )
        continue;
      const text = JSON.stringify({
        author: c.user?.login,
        path: c.path,
        line: c.line,
        comment: c.body,
      });
      if (text.length > 7000)
        throw new Error(
          "MR feedback exceeds supported bounds; explicit review needed",
        );
      result.feedback.push({
        id: digest(`${c.id}:${c.updated_at ?? c.submitted_at}:${text}`),
        text,
      });
    }
    if (ci?.status === "completed" && ci.conclusion !== "success") {
      const jobs = await api(
        `actions/runs/${ci.id}/attempts/${ci.run_attempt}/jobs?per_page=100`,
      );
      if (!Array.isArray(jobs.jobs) || jobs.total_count > 100)
        throw new Error("Unbounded CI job history");
      for (const j of jobs.jobs.filter(
        (j: any) => j.conclusion !== "success",
      )) {
        let annotations: any[] = [];
        const check = /\/check-runs\/([0-9]+)$/.exec(j.check_run_url ?? "");
        if (check)
          annotations = await api(
            `check-runs/${check[1]}/annotations?per_page=100`,
          );
        if (!Array.isArray(annotations) || annotations.length === 100)
          throw new Error("Unbounded check annotations");
        const text = JSON.stringify({
          job: j.name,
          conclusion: j.conclusion,
          steps: j.steps?.filter((s: any) => s.conclusion !== "success"),
          annotations,
        });
        if (text.length > 7000)
          throw new Error(
            "CI feedback exceeds supported bounds; explicit review needed",
          );
        result.feedback.push({
          id: `ci:${ci.id}:${ci.run_attempt}:${j.id}`,
          text,
        });
      }
    }
    return result;
  }
  async ready(t: MergeTarget) {
    const pr = await this.owned(t);
    if (
      pr.state !== "open" ||
      pr.merged ||
      pr.head.sha !== t.head ||
      pr.base.sha !== t.baseSha
    )
      throw new Error("Readiness target changed");
    if (!pr.draft) return;
    const data = await this.graphql(
      "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
      { id: pr.node_id },
    );
    if (data.markPullRequestReadyForReview?.pullRequest?.isDraft !== false)
      throw new Error("PR readiness acknowledgement uncertain");
  }
  async attest(
    t: MergeTarget,
    model: string,
    artifact: string,
    handledFeedback: string[] = [],
  ) {
    const marker = `Chief review attestation: ${t.head}`;
    const comments = await this.api(
      `issues/${this.number(t)}/comments?per_page=100`,
    );
    if (!Array.isArray(comments) || comments.length === 100)
      throw new Error("Attestation history unavailable");
    if (
      !comments.some(
        (c: any) =>
          c.user?.login === "chief-coding-publisher[bot]" &&
          c.body?.startsWith(marker),
      )
    )
      await this.api(`issues/${this.number(t)}/comments`, "POST", {
        body: `${marker}\n\nIndependent squad reviewer: ${model}. APPROVE of artifact ${artifact}; Chief verified the published Git tree ${t.tree} matches the reviewed candidate. The coder and reviewer used separate contexts and read-only review tools. Required GitHub checks remain a separate merge gate. Private findings and source context are not copied here.${handledFeedback.length ? `\n\nChief feedback response: the squad rechecked this candidate against ${handledFeedback.length} collected MR feedback item(s). Reviewer approval is recorded above; external reviewers may still require their own recheck.` : ""}`,
      });
  }
  async merge(t: MergeTarget) {
    const pr = await this.owned(t);
    if (pr.merged === true) {
      if (pr.head.sha !== t.head || !sha(pr.merge_commit_sha))
        throw new Error("Different head was merged");
      return { sha: pr.merge_commit_sha as string };
    }
    if (
      pr.state !== "open" ||
      pr.head.sha !== t.head ||
      pr.base.sha !== t.baseSha
    )
      throw new Error("Merge target changed");
    if (pr.draft) await this.ready(t);
    let r;
    try {
      r = await this.api(`pulls/${this.number(t)}/merge`, "PUT", {
        sha: t.head,
        merge_method: "merge",
      });
    } catch (error) {
      if (
        [403, 404, 405, 409, 422].includes(
          (error as { httpStatus?: number }).httpStatus ?? 0,
        )
      )
        throw new MergeRefused(
          "GitHub refused merge; inspect branch rules or changed head before another attempt",
        );
      throw error;
    }
    if (r.merged !== true || !sha(r.sha))
      throw new Error("Merge acknowledgement uncertain");
    return { sha: r.sha };
  }
  async release(commit: string): Promise<"pending" | "success" | "failure"> {
    if (!sha(commit)) throw new Error("Invalid merge SHA");
    const statuses = await this.api(`commits/${commit}/statuses?per_page=100`);
    if (!Array.isArray(statuses) || statuses.length === 100)
      throw new Error("Release receipt history unavailable");
    const receipt = statuses.find(
      (s: any) => s.context === "companion/production",
    );
    if (!receipt) return "pending";
    const match = new RegExp(
      `^https://github.com/${this.repository}/actions/runs/([0-9]+)$`,
    ).exec(receipt.target_url ?? "");
    if (
      !match ||
      receipt.creator?.login !== "github-actions[bot]" ||
      receipt.creator?.type !== "Bot"
    )
      throw new Error("Untrusted release receipt");
    const run = await this.api(`actions/runs/${match[1]}`);
    if (
      run.path !== ".github/workflows/deploy.yml" ||
      run.head_sha !== commit ||
      run.head_branch !== "main" ||
      run.repository?.full_name !== this.repository ||
      run.head_repository?.full_name !== this.repository ||
      !["workflow_run", "workflow_dispatch"].includes(run.event)
    )
      throw new Error("Release identity mismatch");
    if (run.status !== "completed") return "pending";
    const jobs = await this.api(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    const deploy = jobs.jobs?.find(
      (j: any) => j.name === "deploy" && j.run_id === run.id,
    );
    return receipt.state === "success" &&
      run.conclusion === "success" &&
      deploy?.conclusion === "success"
      ? "success"
      : "failure";
  }
}
