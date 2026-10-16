import { describe, expect, it } from "vitest";
import { TOOL_NAMES, assertValidToolName } from "../src/mcp/toolNames.js";

describe("MCP tool names", () => {
  it("uses the published domain_verb_object operation names", () => {
    expect(Object.values(TOOL_NAMES)).toEqual([
      "ui_open_account", "ui_open_receipt", "ui_open_chart", "ui_read_card",
      "ui_submit_card", "ui_act_card", "ui_read_settings_file", "session_open_review_management",
      "read_get_server_status", "read_list_supported_protocols", "read_list_deepbook_pools",
      "read_list_deepbook_tokens", "read_inspect_deepbook_orderbook", "read_get_deepbook_mid_price",
      "read_get_deepbook_usdc_price_history", "read_get_deepbook_usdc_price_at_time",
      "read_quote_deepbook_action", "read_quote_deepbook_display_amount",
      "read_summarize_deepbook_account_inventory", "read_summarize_wallet_assets",
      "read_classify_wallet_assets", "read_list_settlement_asset_groups",
      "read_summarize_settlement_asset_group_parity", "read_preview_intent_evidence",
      "read_list_review_activity", "read_summarize_review_funnel", "read_get_review_session_detail",
      "read_inspect_sui_transaction", "read_scan_sui_account_activity", "read_summarize_sui_activity_scan",
      "read_scan_sui_function_activity", "read_summarize_sui_function_activity_scan",
      "read_summarize_sui_account_activity", "read_get_account_asset_timeline",
      "settings_create_local_settings_session", "settings_get_local_settings", "action_start_review",
      "action_create_proposal_review", "session_open_wallet_disconnection_card", "session_open_wallet_connection_card",
      "session_get_wallet_connection_card", "session_wait_wallet_connection_card",
      "session_get_interaction_status", "session_get_review_status", "session_get_execution_result",
      "session_wait_execution_result", "account_get_active_account"
    ]);
    for (const name of Object.values(TOOL_NAMES)) {
      expect(() => assertValidToolName(name)).not.toThrow();
      expect(name).not.toContain("/");
    }
  });
});
