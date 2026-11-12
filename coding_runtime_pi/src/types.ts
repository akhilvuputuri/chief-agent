/** The coder changes the workspace; the reviewer reads a separate copy and never edits it. */
export type Role = "coder" | "reviewer";
export type Status =
  | "ready"
  | "running"
  | "waiting_input"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed";
export type FileChange = {
  path: string;
  content: string | null;
  mode?: "100644" | "100755";
};
export type Artifact = {
  patch: string;
  files: FileChange[];
  hash: string;
  base: string;
};
export type Report = {
  kind: "done" | "review" | "ask";
  summary: string;
  /** The full result of done and review; optional record for an ask. */
  detail?: string;
  verdict?: "APPROVE" | "REQUEST_CHANGES";
  /** The short question an ask puts to the owner. */
  ask?: string;
  /** Up to three answers the owner can tap. */
  options?: string[];
};
/**
 * One role's Pi session in one workspace. A task is run many times; each run sends one
 * message into the same session and ends when the model reports or stops.
 */
export type Task = {
  version: 1;
  id: string;
  role: Role;
  status: Status;
  workspace: string;
  /** The commit the candidate is diffed against; never the workspace's HEAD. */
  base: string;
  /** The owner's request, appended to Pi's system prompt so compaction never rewrites it. */
  request?: string;
  summary: string;
  question?: string;
  options?: string[];
  artifact?: Artifact;
  runnerPid?: number;
  sessionFile?: string;
  report?: import("./report.js").ReportDocument;
  events: RuntimeEvent[];
};
export type RuntimeEvent = {
  sequence: number;
  type: "state" | "text" | "tool";
  text: string;
};
export type StartRequest = {
  workspace: string;
  role: Role;
  /** A full commit SHA present in the workspace's repository. */
  base: string;
  /** The owner's request, kept word for word in the system prompt. */
  request?: string;
};
export type ModelConfig = {
  /** An Anthropic model id from Pi's catalogue, such as claude-opus-5-5. */
  model: string;
  /** Messages API origin; a gateway when the box must not hold the Anthropic key. */
  baseUrl?: string;
  apiKey?: string;
  reasoning?: "low" | "medium" | "high";
  contextWindow?: number;
  maxTokens?: number;
  /**
   * Pi's agent retry settings when the endpoint needs other values than Pi's defaults (three
   * retries from two seconds); unset fields keep Pi's defaults.
   */
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxAgentDelayMs?: number;
  };
};
