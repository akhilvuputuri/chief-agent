import { createSign } from "node:crypto";

/** Exactly what the sandbox token may do. Never workflows, actions write, administration or secrets. */
export const AGENT_TOKEN_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
} as const);

export type AgentToken = { token: string; expiresAt: string };

/**
 * Mints single-repository tokens from the separate, minimal chief-coding-agent App.
 * A token is handed out only after GitHub confirms, from that token's own view,
 * that it cannot update main and that auto-merge is off.
 */
export class AgentGitHubTokens {
  constructor(
    private repository: string,
    private appId: string,
    private installationId: string,
    private privateKey: string,
    private transport: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("Agent token repository is invalid");
  }
  private jwt() {
    const now = Math.floor(Date.now() / 1000);
    const part = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const text = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const signer = createSign("RSA-SHA256");
    signer.update(text);
    return `${text}.${signer.sign(this.privateKey, "base64url")}`;
  }
  private async get(token: string, path: string) {
    const response = await this.transport(
      `https://api.github.com/repos/${this.repository}${path}`,
      {
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new Error(`Agent token verification failed (${response.status})`);
    return response.json() as Promise<any>;
  }
  /** Fails closed unless main requires PRs and `test`, restricts updates, and this token cannot bypass. */
  async verify(token: string) {
    const rules: any[] = await this.get(token, "/rules/branches/main");
    if (!Array.isArray(rules)) throw new Error("Main rules are unreadable");
    const types = new Set(rules.map((r) => r?.type));
    const testRequired = rules.some(
      (r) =>
        r?.type === "required_status_checks" &&
        r.parameters?.required_status_checks?.some(
          (c: any) => c?.context === "test",
        ),
    );
    if (!types.has("update") || !types.has("pull_request") || !testRequired)
      throw new Error(
        "Main must require a pull request and the test check and restrict updates before an agent token is issued",
      );
    const rulesets = [
      ...new Set(
        rules
          .map((r) => r?.ruleset_id)
          .filter((id) => Number.isSafeInteger(id)),
      ),
    ];
    if (!rulesets.length) throw new Error("Main rulesets are unreadable");
    for (const id of rulesets) {
      const ruleset = await this.get(token, `/rulesets/${id}`);
      if (ruleset?.current_user_can_bypass !== "never")
        throw new Error(
          "The agent identity must not be able to bypass main rules",
        );
    }
    const repository = await this.get(token, "");
    if (repository?.allow_auto_merge !== false)
      throw new Error("Repository auto-merge must stay disabled");
  }
  async issue(): Promise<AgentToken> {
    const response = await this.transport(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${this.jwt()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repositories: [this.repository.split("/")[1]],
          permissions: AGENT_TOKEN_PERMISSIONS,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Agent token issuance failed (${response.status})`);
    const data: any = await response.json();
    if (
      typeof data.token !== "string" ||
      !Number.isFinite(Date.parse(data.expires_at))
    )
      throw new Error("Invalid agent token response");
    // GitHub may narrow but must never widen what was requested.
    const granted = data.permissions;
    if (
      !granted ||
      typeof granted !== "object" ||
      Object.entries(granted).some(([name, level]) =>
        (AGENT_TOKEN_PERMISSIONS as Record<string, string>)[name] === undefined
          ? name !== "metadata"
          : level !== (AGENT_TOKEN_PERMISSIONS as Record<string, string>)[name],
      )
    ) {
      await this.revoke(data.token);
      throw new Error("Agent token permissions differ from the pinned set");
    }
    try {
      await this.verify(data.token);
    } catch (error) {
      await this.revoke(data.token);
      throw error;
    }
    return { token: data.token, expiresAt: data.expires_at };
  }
  /** Best effort: an unrevoked token still expires within an hour. */
  async revoke(token: string) {
    try {
      await this.transport("https://api.github.com/installation/token", {
        method: "DELETE",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      /* Expiry bounds an unrevoked token. */
    }
  }
}
