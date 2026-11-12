/**
 * The most tool calls Chief accepts in one model response. The OpenRouter stream and the
 * direct Anthropic adapter reject a response with more, and the Pi facade refuses replayed
 * history with more, so a response that a later request could not replay is never accepted
 * (journal 170).
 */
export const MAX_TOOL_CALLS = 20;
