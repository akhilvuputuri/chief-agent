/**
 * Box agent entry point. Configuration comes from the environment the provider prepares
 * (EC2 user data is written to an environment file by the bootstrap script; the local
 * provider passes it directly).
 *
 *   CHIEF_BOX_ORIGIN, CHIEF_BOX_ID, CHIEF_BOX_STATE   required
 *   CHIEF_BOX_BOOTSTRAP                               single-use secret (first boot)
 *   CHIEF_BOX_RUNNER=process|docker                   default docker
 *   CHIEF_BOX_TASK_COMMAND                            JSON array (process runner)
 *   CHIEF_BOX_TASK_IMAGE                              image digest (docker runner)
 *   CHIEF_BOX_TASK_MEMORY, CHIEF_BOX_TASK_CPUS        per-task limits (docker runner)
 *   CHIEF_BOX_TASK_COMMAND_B64                        base64 JSON command override (docker runner)
 *   CHIEF_BOX_SHUTDOWN=exit|poweroff                  default poweroff
 *   CHIEF_BOX_IDENTITY=ec2                            present the EC2 identity document
 *   CHIEF_BOX_BOOT_STAGES                             boot script's stage file, reported once
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BoxAgent, DockerRunner, ProcessRunner, StateStore } from "./agent.js";
import { parseBootStages } from "./boot-stages.js";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const stateDir = required("CHIEF_BOX_STATE");
const store = new StateStore(stateDir);
// Task workspaces live apart from the agent's own state files.
const tasks = join(stateDir, "work");
const runner =
  env.CHIEF_BOX_RUNNER === "process"
    ? new ProcessRunner(JSON.parse(required("CHIEF_BOX_TASK_COMMAND")), tasks)
    : new DockerRunner(required("CHIEF_BOX_TASK_IMAGE"), tasks, {
        command: env.CHIEF_BOX_TASK_COMMAND_B64
          ? (JSON.parse(
              Buffer.from(env.CHIEF_BOX_TASK_COMMAND_B64, "base64").toString(),
            ) as string[])
          : undefined,
        memory: env.CHIEF_BOX_TASK_MEMORY,
        scope: env.CHIEF_BOX_ID,
        cpus: env.CHIEF_BOX_TASK_CPUS,
      });

/**
 * On EC2, the AWS-signed instance identity document and its signature, read through
 * IMDSv2 by the agent on the host (task containers are blocked from the service).
 */
async function ec2Identity() {
  const imds = "http://169.254.169.254/latest";
  // A throttled or failed metadata read throws, so hello is retried rather than sending an
  // error page as proof (which the host would refuse, ending the box).
  const text = async (response: Response) => {
    if (!response.ok)
      throw new Error(`Instance metadata answered ${response.status}`);
    return response.text();
  };
  const token = await text(
    await fetch(`${imds}/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(5000),
    }),
  );
  const read = async (path: string) =>
    text(
      await fetch(`${imds}/dynamic/instance-identity/${path}`, {
        headers: { "X-aws-ec2-metadata-token": token },
        signal: AbortSignal.timeout(5000),
      }),
    );
  return {
    document: await read("document"),
    signature: await read("signature"),
  };
}

const agent = new BoxAgent({
  identity: env.CHIEF_BOX_IDENTITY === "ec2" ? ec2Identity : undefined,
  bootStages: env.CHIEF_BOX_BOOT_STAGES
    ? () => {
        try {
          return parseBootStages(
            readFileSync(env.CHIEF_BOX_BOOT_STAGES!, "utf8"),
          );
        } catch {
          return [];
        }
      }
    : undefined,
  origin: required("CHIEF_BOX_ORIGIN"),
  boxId: required("CHIEF_BOX_ID"),
  bootstrap: env.CHIEF_BOX_BOOTSTRAP,
  store,
  runner,
  shutdown: (reason) => {
    process.stderr.write(`box agent ending: ${reason}\n`);
    if (env.CHIEF_BOX_SHUTDOWN === "exit") process.exit(0);
    // With InstanceInitiatedShutdownBehavior=terminate, this terminates the instance.
    spawnSync("systemctl", ["poweroff"], { stdio: "ignore" });
    process.exit(0);
  },
});

// A host stop (EC2 StopInstances) arrives as SIGTERM: exit quietly and resume on start.
process.on("SIGTERM", () => {
  agent.cancelCurrent();
  process.exit(0);
});
await agent.run();
