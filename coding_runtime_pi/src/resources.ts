import {
  createExtensionRuntime,
  type Extension,
  type BeforeAgentStartEvent,
  type ResourceLoader,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Host-owned text/resources only. No project/global executable discovery. */
export function resources(
  prompt: string,
  agentsFiles: Array<{ path: string; content: string }> = [],
  beforeStart?: (prompt: string) => string | undefined,
  beforeCompact?: (
    event: SessionBeforeCompactEvent,
    context: ExtensionContext,
  ) => Promise<SessionBeforeCompactResult>,
): ResourceLoader {
  const phase: Extension = {
    path: "<inline:host-phase>",
    resolvedPath: "<inline:host-phase>",
    sourceInfo: {
      path: "<inline:host-phase>",
      source: "inline",
      scope: "temporary",
      origin: "top-level",
    },
    handlers: new Map([
      [
        "before_agent_start",
        [
          async (raw: unknown) => {
            const e = raw as BeforeAgentStartEvent;
            const systemPrompt = beforeStart?.(e.systemPrompt);
            return systemPrompt ? { systemPrompt } : undefined;
          },
        ],
      ],
    ]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  if (beforeCompact)
    phase.handlers.set("session_before_compact", [
      async (event, context) =>
        beforeCompact(
          event as SessionBeforeCompactEvent,
          context as ExtensionContext,
        ),
    ]);
  return {
    getExtensions: () => ({
      extensions: beforeStart || beforeCompact ? [phase] : [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
