/** One coding attempt's sandbox request; the identity is delivered to the worker. */
export type SandboxRequest = {
  jobId: string;
  attemptId: string;
  token: string;
  origin: string;
  image: string;
  runtime?: "node" | "python" | "pi";
  timeoutMinutes: number;
};
export class SandboxAcknowledgementPending extends Error {
  constructor() {
    super("Sandbox launch acknowledgement is pending");
    this.name = "SandboxAcknowledgementPending";
  }
}
/**
 * Where coding attempts run. Since phase 6 (docs/boxes.md) that is one EC2 box per attempt
 * (`BoxSandbox`); CodeBuild is gone.
 */
export interface SandboxProvider {
  create(request: SandboxRequest): Promise<string>;
  find(attemptId: string, timeoutMinutes?: number): Promise<string | undefined>;
  inspect(id: string): Promise<"running" | "terminal">;
  terminate(id: string): Promise<void>;
  terminalReason?(id: string): Promise<string | undefined>;
  /** Extra time before the first heartbeat is expected from this sandbox. */
  startupGraceMs?(id: string | null | undefined): number;
  /** Whether this sandbox can run the attempt at all; a refusal pauses it before launch. */
  accepts?(request: SandboxRequest): boolean;
}
