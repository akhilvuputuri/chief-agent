import {
  createExtensionRuntime,
  type Extension,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/**
 * Host-owned text/resources only. No project/global executable discovery. Pi builds its own
 * default system prompt (tool list and tool rules); the role text is appended through Pi's
 * append mechanism. The one extension handler saves the work at each turn end, where Pi
 * awaits it before the next model call and the next tool, so a save never races a tool.
 * Nothing else (compaction, prompts, tool calls) is replaced or observed.
 */
export function resources(
  role: string,
  agentsFiles: Array<{ path: string; content: string }> = [],
  turnEnd?: () => Promise<void>,
): ResourceLoader {
  const save: Extension = {
    path: "<inline:checkpoint>",
    resolvedPath: "<inline:checkpoint>",
    sourceInfo: {
      path: "<inline:checkpoint>",
      source: "inline",
      scope: "temporary",
      origin: "top-level",
    },
    handlers: new Map([["turn_end", [async () => turnEnd?.()]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
  return {
    getExtensions: () => ({
      extensions: turnEnd ? [save] : [],
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
