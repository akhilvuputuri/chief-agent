import {
  createExtensionRuntime,
  type Extension,
  type BeforeAgentStartEvent,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/** Host-owned text/resources only. No project/global executable discovery. */
export function resources(
  prompt: string,
  agentsFiles: Array<{ path: string; content: string }> = [],
  beforeStart?: (prompt: string) => string | undefined,
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
  return {
    getExtensions: () => ({
      extensions: beforeStart ? [phase] : [],
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
