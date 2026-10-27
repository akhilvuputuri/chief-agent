import { IBKR, IbkrAuthError } from "./oauth.js";
import { readBody } from "../http-body.js";
import {
  IBKR_DRAFT_TOOLS,
  IBKR_QUERY_TOOLS,
  IBKR_READ_TOOLS,
  type IbkrReadTool,
} from "./catalogue.js";

export {
  IBKR_DRAFT_TOOLS,
  IBKR_QUERY_TOOLS,
  IBKR_READ_TOOLS,
  type IbkrReadTool,
};

const CALLABLE: ReadonlySet<string> = new Set([
  ...IBKR_READ_TOOLS,
  ...IBKR_QUERY_TOOLS,
  ...IBKR_DRAFT_TOOLS,
]);

/** One allowlisted tool call inside an open MCP session. */
export type IbkrCall = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const MAX_BODY = 2_000_000;
const PROTOCOL = "2025-06-18";

export class IbkrMcpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly transient: boolean,
    /** IBKR's own error text for a tool error, bounded and stripped of control characters. */
    readonly detail?: string,
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
    return this.run(user, async (call) => {
      const out = {} as Record<T, unknown>;
      for (const name of tools) out[name] = await call(name);
      return out;
    });
  }

  /**
   * Runs `work` in one MCP session. An access token rejected before its expiry is refreshed
   * once and the whole work is retried. A 401 is assumed to mean IBKR processed nothing
   * (standard, unmeasured for IBKR); a work that creates an instruction checks for an
   * identical recent one before creating, so a wrong assumption cannot send it twice.
   */
  async run<T>(user: string, work: (call: IbkrCall) => Promise<T>): Promise<T> {
    let retried = false;
    for (;;) {
      try {
        return await this.session(user, work);
      } catch (error) {
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

  private async session<T>(user: string, work: (call: IbkrCall) => Promise<T>) {
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
    return work(async (name, args = {}) => {
      if (!CALLABLE.has(name))
        throw new IbkrMcpError(
          "Tool not allowlisted",
          "not_allowlisted",
          false,
        );
      const result = (await this.rpc(state, "tools/call", {
        name,
        arguments: args,
      })) as any;
      const text = Array.isArray(result?.content)
        ? result.content.find((c: any) => c?.type === "text")?.text
        : undefined;
      if (result?.isError)
        throw new IbkrMcpError(
          `${name} returned an error`,
          "tool_error",
          true,
          typeof text === "string"
            ? text
                .replace(/[\u0000-\u001f\u007f]+/g, " ")
                .replace(/ {2,}/g, " ")
                .trim()
                .slice(0, 300)
            : undefined,
        );
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
      return structured;
    });
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
  const body = await readBody(
    response,
    MAX_BODY,
    () => new IbkrMcpError("IBKR response too large", "too_large", false),
  );
  return body.toString("utf8");
}
