/**
 * The IBKR MCP tools Chief may call. The server lists live-order, order-instruction, alert
 * and watchlist write tools even under an mcp.read token (measured 2 October and 20 October
 * 2026), so these allowlists are a required boundary, not a second layer. Every other tool,
 * including submit_order, modify_order, cancel_order and answer_order_question, is refused.
 */
/** Holdings sync. Host code calls these by constant. */
export const IBKR_READ_TOOLS = [
  "get_account_positions",
  "get_account_balances",
  // Read only for the account's base currency; its margin/leverage fields are not shown.
  "get_account_summary",
] as const;
export type IbkrReadTool = (typeof IBKR_READ_TOOLS)[number];

/**
 * Read-only tools the portfolio agent may query by name (owner request, 20 October 2026).
 * Each is annotated readOnlyHint and listed under mcp.read. Reads that only serve
 * autonomous live trading (get_order_rules, get_order_status, preview_order) are left out:
 * Chief only uses review-and-approve instructions.
 */
export const IBKR_QUERY_TOOLS = [
  "get_account_positions",
  "get_account_balances",
  "get_account_summary",
  "get_account_orders",
  "get_account_trades",
  "get_pa_allocation",
  "get_pa_performance_all_periods",
  "get_order_instructions",
  "get_flow_type",
  "search_contracts",
  "search_futures",
  "get_combo_identifier",
  "get_option_data",
  "get_option_parameters",
  "get_price_snapshot",
  "get_price_history",
  "get_company_connections",
  "get_company_themes",
  "get_theme_details",
  "search_investment_topics",
  "get_alert",
  "get_alerts",
  "get_watchlist",
  "get_watchlists",
  "list_saved_screeners",
  "get_saved_screener",
  "run_saved_screener",
  "whats_new",
] as const;
export type IbkrQueryTool = (typeof IBKR_QUERY_TOOLS)[number];

/**
 * The only IBKR writes: order instructions, which IBKR keeps as drafts until the owner
 * taps Review & Submit in an IBKR app. Host code calls these by constant.
 */
export const IBKR_DRAFT_TOOLS = [
  "create_order_instruction",
  "delete_order_instruction",
] as const;
