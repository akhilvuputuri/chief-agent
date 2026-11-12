import {
  createExtensionRuntime,
  type Extension,
  type BeforeAgentStartEvent,
  type ResourceLoader,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Host-owned text/resources only. No project/global executable discovery. Pi builds its own
 * default system prompt (tool list and tool rules); the role text is appended through Pi's
 * append mechanism, and `phase` adds a section for one run without replacing the prompt.
 */
export function resources(
  role: string,
  agentsFiles: Array<{ path: string; content: string }> = [],
  phase?: () => string | undefined,
  beforeCompact?: (
    event: SessionBeforeCompactEvent,
    context: ExtensionContext,
  ) => Promise<SessionBeforeCompactResult>,
): ResourceLoader {
  const host: Extension = {
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
            const text = phase?.();
            if (text)
              (
                raw as BeforeAgentStartEvent
              ).systemPromptOptions.sections.host_phase = text;
            return undefined;
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
    host.handlers.set("session_before_compact", [
      async (event, context) =>
        beforeCompact(
          event as SessionBeforeCompactEvent,
          context as ExtensionContext,
        ),
    ]);
  return {
    getExtensions: () => ({
      extensions: phase || beforeCompact ? [host] : [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [role],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
