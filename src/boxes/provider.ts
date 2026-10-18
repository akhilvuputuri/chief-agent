/** Provider-side view of one box's compute. `missing` means the provider has no record. */
export type ProviderState =
  "pending" | "running" | "stopping" | "stopped" | "terminated" | "missing";

export interface LaunchRequest {
  boxId: string;
  /** Idempotency token derived from the box ID; a retried launch never creates a second box. */
  clientToken: string;
  profile: string;
  image: string;
  environment: string;
  /** Delivered to the box agent (EC2 user data, container environment); single-use. */
  bootstrap: { origin: string; boxId: string; secret: string };
}

export interface BoxProvider {
  readonly kind: string;
  /** Whether the provider can stop a box with its disk kept and start it again. */
  readonly canStop: boolean;
  launch(request: LaunchRequest): Promise<string>;
  /** Finds this environment's resource for a box after an uncertain launch. */
  find(boxId: string): Promise<string | undefined>;
  describe(providerId: string): Promise<ProviderState>;
  stop(providerId: string): Promise<void>;
  start(providerId: string): Promise<void>;
  terminate(providerId: string): Promise<void>;
  /** Every live resource tagged for this environment, for the orphan sweep. */
  list(): Promise<{ providerId: string; boxId?: string }[]>;
  /** Optional proof that a hello comes from the recorded instance (EC2 identity document). */
  verifyIdentity?(providerId: string, proof: unknown): Promise<boolean>;
}

/** In-memory provider for tests and local reasoning about the reconciler. */
export class FakeBoxProvider implements BoxProvider {
  readonly kind = "fake";
  readonly canStop: boolean;
  readonly boxes = new Map<
    string,
    { boxId: string; state: ProviderState; request: LaunchRequest }
  >();
  readonly calls: string[] = [];
  private byToken = new Map<string, string>();
  private next = 1;
  /** Set to make the next call of that name throw (uncertain provider responses). */
  fail = new Set<string>();
  constructor(options: { canStop?: boolean } = {}) {
    this.canStop = options.canStop ?? true;
  }
  private check(name: string) {
    this.calls.push(name);
    if (this.fail.delete(name)) throw new Error(`fake ${name} failure`);
  }
  async launch(request: LaunchRequest) {
    const existing = this.byToken.get(request.clientToken);
    if (existing) return existing;
    const id = `fake-${this.next++}`;
    this.byToken.set(request.clientToken, id);
    this.boxes.set(id, { boxId: request.boxId, state: "running", request });
    // An uncertain launch: the resource exists, but the caller never hears back.
    this.check("launch");
    return id;
  }
  async find(boxId: string) {
    this.check("find");
    for (const [id, box] of this.boxes)
      if (box.boxId === boxId && box.state !== "terminated") return id;
    return undefined;
  }
  async describe(id: string) {
    this.check("describe");
    return this.boxes.get(id)?.state ?? "missing";
  }
  private set(id: string, state: ProviderState) {
    const box = this.boxes.get(id);
    if (box && box.state !== "terminated") box.state = state;
  }
  async stop(id: string) {
    this.check("stop");
    if (!this.canStop) throw new Error("fake provider cannot stop");
    this.set(id, "stopped");
  }
  async start(id: string) {
    this.check("start");
    this.set(id, "running");
  }
  async terminate(id: string) {
    this.check("terminate");
    this.set(id, "terminated");
  }
  async list() {
    this.check("list");
    return [...this.boxes]
      .filter(([, box]) => box.state !== "terminated")
      .map(([providerId, box]) => ({ providerId, boxId: box.boxId }));
  }
  /** Simulates a resource created outside any box row (or left behind by a lost row). */
  orphan(boxId: string) {
    const id = `fake-${this.next++}`;
    this.boxes.set(id, {
      boxId,
      state: "running",
      request: {} as LaunchRequest,
    });
    return id;
  }
}
