/**
 * The most tool calls Chief accepts in one streamed OpenRouter response, and in one replayed
 * Pi assistant message. Pi coding calls pass it as maxToolCalls, so the direct Anthropic
 * adapter also rejects a response with more, and a response a later request could not
 * replay is never accepted (journal 170).
 */
export const MAX_TOOL_CALLS = 20;
