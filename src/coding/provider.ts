import {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand,
  ListBuildsForProjectCommand,
  StopBuildCommand,
  BatchGetProjectsCommand,
} from "@aws-sdk/client-codebuild";

export type SandboxRequest = {
  jobId: string;
  attemptId: string;
  token: string;
  origin: string;
  image: string;
  runtime?: "node" | "python" | "pi";
  timeoutMinutes: number;
};
export class SandboxTimeoutMismatch extends Error {
  constructor(
    readonly sandboxId: string,
    readonly requestedMinutes: number,
    readonly actualMinutes?: number,
  ) {
    super(
      actualMinutes === undefined
        ? "Sandbox provider did not confirm its timeout; launch is paused before work proceeds"
        : `Sandbox provider accepted ${actualMinutes} minutes, below the requested ${requestedMinutes} minutes; launch is paused before work proceeds`,
    );
    this.name = "SandboxTimeoutMismatch";
  }
}
export interface SandboxProvider {
  create(request: SandboxRequest): Promise<string>;
  find(attemptId: string, timeoutMinutes?: number): Promise<string | undefined>;
  inspect(id: string): Promise<"running" | "terminal">;
  terminate(id: string): Promise<void>;
  terminalReason?(id: string): Promise<string | undefined>;
}

/** Reviewed NO_SOURCE project. Repository code never selects buildspec, role or image. */
export class CodeBuildSandbox implements SandboxProvider {
  constructor(
    private client: Pick<CodeBuildClient, "send">,
    private project: string,
  ) {}
  async validate() {
    const result = await this.client.send(
      new BatchGetProjectsCommand({ names: [this.project] }),
    );
    const project = result.projects?.[0];
    if (
      !project ||
      project.source?.type !== "NO_SOURCE" ||
      project.environment?.privilegedMode ||
      project.environment?.environmentVariables?.length ||
      project.secondarySources?.length ||
      project.logsConfig?.cloudWatchLogs?.status !== "DISABLED" ||
      project.logsConfig?.s3Logs?.status !== "DISABLED"
    )
      throw new Error(
        "Coding requires a dedicated unprivileged NO_SOURCE project with no environment secrets or build logs",
      );
  }
  async create(r: SandboxRequest) {
    const result = await this.client.send(
      new StartBuildCommand({
        projectName: this.project,
        idempotencyToken: r.attemptId,
        sourceTypeOverride: "NO_SOURCE",
        imageOverride: r.image,
        privilegedModeOverride: false,
        autoRetryLimitOverride: 0,
        timeoutInMinutesOverride: r.timeoutMinutes,
        queuedTimeoutInMinutesOverride: 5,
        buildspecOverride: `version: 0.2\nrun-as: root\nphases:\n  build:\n    commands:\n      - setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs --bounding-set=-all ${r.runtime === "pi" ? "node --disable-sigusr1 /opt/chief-worker/dist/coding/pi-worker.js" : r.runtime === "python" ? "python -I -m chief_coding_runtime.worker" : "node --disable-sigusr1 /opt/chief-worker/dist/coding/worker.js"}\n`,
        logsConfigOverride: {
          cloudWatchLogs: { status: "DISABLED" },
          s3Logs: { status: "DISABLED" },
        },
        environmentVariablesOverride: Object.entries({
          CODING_JOB_ID: r.jobId,
          CODING_ATTEMPT_ID: r.attemptId,
          CODING_JOB_TOKEN: r.token,
          CODING_ORIGIN: r.origin,
        }).map(([name, value]) => ({ name, value, type: "PLAINTEXT" })),
      }),
    );
    if (!result.build?.id)
      throw new Error(
        "Sandbox creation returned no identity; reconcile before retrying",
      );
    this.confirmTimeout(
      result.build.id,
      result.build.timeoutInMinutes,
      r.timeoutMinutes,
    );
    return result.build.id;
  }
  private confirmTimeout(
    id: string,
    actual: number | undefined,
    requested: number,
  ) {
    if (
      !Number.isInteger(actual) ||
      actual! < 5 ||
      actual! > 2160 ||
      actual! < requested
    )
      throw new SandboxTimeoutMismatch(
        id,
        requested,
        Number.isInteger(actual) && actual! >= 5 && actual! <= 2160
          ? actual
          : undefined,
      );
  }
  async find(attemptId: string, timeoutMinutes?: number) {
    let token: string | undefined;
    // Bounded reconciliation. A missing result does not authorize a new StartBuild.
    for (let page = 0; page < 5; page++) {
      const list = await this.client.send(
        new ListBuildsForProjectCommand({
          projectName: this.project,
          sortOrder: "DESCENDING",
          nextToken: token,
        }),
      );
      const ids = list.ids ?? [];
      if (!ids.length) return undefined;
      const builds = await this.client.send(new BatchGetBuildsCommand({ ids }));
      const match = builds.builds?.find((b) =>
        b.environment?.environmentVariables?.some(
          (v) => v.name === "CODING_ATTEMPT_ID" && v.value === attemptId,
        ),
      );
      if (match?.id) {
        if (timeoutMinutes !== undefined)
          this.confirmTimeout(match.id, match.timeoutInMinutes, timeoutMinutes);
        return match.id;
      }
      token = list.nextToken;
      if (!token) return undefined;
    }
    throw new Error(
      "Sandbox reconciliation window exceeded; operator inspection required",
    );
  }
  async inspect(id: string) {
    const result = await this.client.send(
      new BatchGetBuildsCommand({ ids: [id] }),
    );
    const build = result.builds?.[0];
    if (!build?.buildStatus) throw new Error("Sandbox status unavailable");
    const status = String(build.buildStatus);
    if (["IN_PROGRESS", "QUEUED"].includes(status)) return "running" as const;
    if (
      ["SUCCEEDED", "FAILED", "FAULT", "TIMED_OUT", "STOPPED"].includes(status)
    )
      return "terminal" as const;
    throw new Error("Unknown sandbox state; cleanup requires inspection");
  }
  async terminalReason(id: string) {
    const build = (
      await this.client.send(new BatchGetBuildsCommand({ ids: [id] }))
    ).builds?.[0];
    if (!build || ["IN_PROGRESS", "QUEUED"].includes(String(build.buildStatus)))
      return undefined;
    if (
      build.buildStatus !== "TIMED_OUT" &&
      !build.phases?.some((p) => p.phaseStatus === "TIMED_OUT")
    )
      return undefined;
    const minutes = build.timeoutInMinutes;
    return Number.isInteger(minutes) && minutes! >= 5 && minutes! <= 2160
      ? `Sandbox provider timed out after ${minutes} minutes before a result was recorded; saved work is retained`
      : "Sandbox provider timed out before a result was recorded; saved work is retained";
  }
  async terminate(id: string) {
    await this.client.send(new StopBuildCommand({ id }));
  }
}
