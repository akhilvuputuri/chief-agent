/**
 * The `echo` profile's task program: proves the box loop end to end without any model.
 * It speaks the box task protocol (JSON lines on stdin and stdout). With `waitForMessage`
 * it asks a question and waits for the owner's answer. `hostile` tries to leave state
 * behind for the next task; `inspect` reports whatever an earlier task left.
 */
import { createInterface } from "node:readline";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const out = (value: object) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const home = process.env.HOME ?? "/tmp";
const marker = "chief-box-leftover";

let task:
  { id: string; kind: string; payload: Record<string, any> } | undefined;
const messages: string[] = [];
let waiting: ((text: string) => void) | undefined;

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type === "task" && !task) {
    task = input;
    void run();
  } else if (input.type === "message") {
    messages.push(input.text);
    waiting?.(input.text);
  }
});

async function run() {
  const payload = task!.payload ?? {};
  out({ type: "progress", payload: { step: "started" } });
  if (payload.waitForMessage) {
    out({ type: "question", payload: { text: "What should I echo?" } });
    if (!messages.length)
      await new Promise<string>((resolve) => (waiting = resolve));
  }
  if (payload.hostile) {
    writeFileSync(join(home, marker), "left behind");
    writeFileSync(join(process.cwd(), marker), "left behind");
    writeFileSync(join("/tmp", `${marker}-${process.pid}`), "left behind");
    spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  // `probe` reports the task's own privileges, as seen from inside its sandbox.
  const probe = payload.probe
    ? {
        uid: process.getuid?.(),
        capEff: /CapEff:\s*([0-9a-f]+)/.exec(
          readFileSync("/proc/self/status", "utf8"),
        )?.[1],
        rootReadOnly: readFileSync("/proc/self/mountinfo", "utf8")
          .split("\n")
          .some(
            (l) =>
              l.split(" ")[4] === "/" &&
              /(^|,)ro(,|$)/.test(l.split(" ")[5] ?? ""),
          ),
      }
    : undefined;
  const leftovers = payload.inspect
    ? [home, process.cwd(), "/tmp"].flatMap((dir) =>
        existsSync(dir)
          ? readdirSync(dir)
              .filter((f) => f.startsWith(marker))
              .map((f) => join(dir, f))
          : [],
      )
    : undefined;
  out({
    type: "result",
    payload: {
      echo: payload.text ?? null,
      messages,
      ...(leftovers ? { leftovers } : {}),
      ...(probe ? { probe } : {}),
    },
  });
}
