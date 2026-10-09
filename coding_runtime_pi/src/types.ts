export type Intent = "learn" | "plan" | "build" | "review";
export type Status =
  | "ready"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed";
export type Limits = { ms: number; models: number; tools: number };
export type Check = { command: string; exitCode: number; output: string };
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
export type Plan = { revision: number; text: string; hash: string };
export type Report = {
  kind: "learned" | "plan" | "question" | "done" | "review";
  summary: string;
  detail: string;
  verdict?: "APPROVE" | "REQUEST_CHANGES";
};
export type Task = {
  version: 1;
  id: string;
  revision: number;
  intent: Intent;
  status: Status;
  workspace: string;
  base: string;
  objective: string;
  instructions: string;
  ownerInstructions: string;
  limits: Limits;
  used: { models: number; tools: number; ms: number };
  checkCommands: string[];
  plan?: Plan;
  approved?: { revision: number; hash: string };
  summary: string;
  question?: string;
  checks: Check[];
  artifact?: Artifact;
  runnerPid?: number;
  sessionFile?: string;
  activeRun?: { startedAt: number; reservedMs: number };
  report?: Report;
  events: RuntimeEvent[];
};
export type RuntimeEvent = {
  sequence: number;
  type: "state" | "text" | "tool" | "check";
  text: string;
};
export type StartRequest = {
  workspace: string;
  objective: string;
  intent?: "learn" | "plan";
  instructions?: string;
  limits?: Limits;
  checks?: string[];
};
export type ModelConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  reasoning?: "off" | "low" | "medium" | "high";
  contextWindow?: number;
  maxTokens?: number;
  requestIdField?: string;
  maxRequestBytes?: number;
};
export const defaultLimits: Limits = {
  ms: 7_200_000,
  models: 400,
  tools: 1000,
};
