import { IBKR, IbkrAuthError } from "./oauth.js";

/**
 * The complete set of IBKR MCP tools Chief may call. The server lists order-instruction,
 * alert and watchlist write tools even under an mcp.read token (measured 2 October 2026),
 * so this allowlist is a required boundary, not a second layer. The model never names an
 * MCP tool; host code calls these by constant.
 */
export const IBKR_READ_TOOLS = [
  "get_account_positions",
  "get_account_balances",
  // Read only for the account's base currency; its margin/leverage fields are not shown.
  "get_account_summary",
] as const;
export type IbkrReadTool = (typeof IBKR_READ_TOOLS)[number];

const MAX_BODY = 2_000_000;
const PROTOCOL = "2025-06-18";

export class IbkrMcpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** Minimal Streamable HTTP JSON-RPC client: initialize, then tools/call. No server features. */
export class IbkrMcp {
  constructor(
    private token: (user: string, force?: boolean) => Promise<string>,
    private http: Fetch = fetch,
  ) {}

  /** Calls allowlisted read tools in one MCP session and returns their structured results. */
  async read<T extends IbkrReadTool>(
    user: string,
    tools: readonly T[],
  ): Promise<Record<T, unknown>> {
    for (const name of tools)
      if (!(IBKR_READ_TOOLS as readonly string[]).includes(name))
        throw new IbkrMcpError(
          "Tool not allowlisted",
          "not_allowlisted",
          false,
        );
    let retried = false;
    for (;;) {
      try {
        return await this.session(user, tools);
      } catch (error) {
        // An access token rejected before its expiry: refresh once and retry the reads.
        if (
          error instanceof IbkrMcpError &&
          error.code === "http_401" &&
          !retried
        ) {
          retried = true;
          await this.token(user, true);
          continue;
        }
        throw error;
      }
    }
  }

  private async session<T extends IbkrReadTool>(
    user: string,
    tools: readonly T[],
  ) {
    const state = {
      user,
      session: null as string | null,
      protocol: PROTOCOL,
      id: 1,
    };
    const init = (await this.rpc(state, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "chief", version: "1" },
    })) as any;
    if (typeof init?.protocolVersion === "string")
      state.protocol = init.protocolVersion.slice(0, 20);
    await this.rpc(state, "notifications/initialized", {}, true);
    const out = {} as Record<T, unknown>;
    for (const name of tools) {
      const result = (await this.rpc(state, "tools/call", {
        name,
        arguments: {},
      })) as any;
      if (result?.isError)
        throw new IbkrMcpError(`${name} returned an error`, "tool_error", true);
      const text = Array.isArray(result?.content)
        ? result.content.find((c: any) => c?.type === "text")?.text
        : undefined;
      let structured = result?.structuredContent;
      if (structured == null && typeof text === "string") {
        try {
          structured = JSON.parse(text);
        } catch {
          throw new IbkrMcpError(
            `${name} returned unreadable content`,
            "malformed",
            false,
          );
        }
      }
      out[name] = structured;
    }
    return out;
  }

  private async rpc(
    state: {
      user: string;
      session: string | null;
      protocol: string;
      id: number;
    },
    method: string,
    params: unknown,
    notify = false,
  ) {
    const id = notify ? undefined : state.id++;
    const token = await this.token(state.user).catch((error) => {
      if (error instanceof IbkrAuthError) throw error;
      throw new IbkrMcpError("Token unavailable", "token_unavailable", true);
    });
    let response: Response;
    try {
      response = await this.http(IBKR.resource, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": state.protocol,
          ...(state.session ? { "Mcp-Session-Id": state.session } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notify ? {} : { id }),
          method,
          params,
        }),
      });
    } catch {
      throw new IbkrMcpError("IBKR MCP unreachable", "unreachable", true);
    }
    const session = response.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,200}$/.test(session))
      state.session = session;
    const text = await bounded(response);
    if (!response.ok)
      throw new IbkrMcpError(
        `IBKR MCP HTTP ${response.status}`,
        `http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    if (notify) return null;
    const messages = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream",
    )
      ? text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => {
            try {
              return JSON.parse(line.slice(5));
            } catch {
              return null;
            }
          })
      : (() => {
          try {
            return [JSON.parse(text)];
          } catch {
            return [];
          }
        })();
    // A response, not a server-initiated request that happens to reuse the id.
    const message = messages.find(
      (m: any) => m?.id === id && ("result" in m || "error" in m),
    );
    if (!message)
      throw new IbkrMcpError(`${method}: no response`, "malformed", true);
    if (message.error)
      throw new IbkrMcpError(`${method}: JSON-RPC error`, "rpc_error", false);
    return message.result;
  }
}

async function bounded(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new IbkrMcpError("IBKR response too large", "too_large", false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
