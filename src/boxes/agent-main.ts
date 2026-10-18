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
 *   CHIEF_BOX_SHUTDOWN=exit|poweroff                  default poweroff
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { BoxAgent, DockerRunner, ProcessRunner, StateStore } from "./agent.js";

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
        memory: env.CHIEF_BOX_TASK_MEMORY,
        scope: env.CHIEF_BOX_ID,
        cpus: env.CHIEF_BOX_TASK_CPUS,
      });

const agent = new BoxAgent({
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
