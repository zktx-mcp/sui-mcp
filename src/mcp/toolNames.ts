export const TOOL_NAMES = {
  uiOpenAccount: "ui_open_account",
  uiOpenReceipt: "ui_open_receipt",
  uiOpenChart: "ui_open_chart",
  uiReadCard: "ui_read_card",
  uiSubmitCard: "ui_submit_card",
  uiActCard: "ui_act_card",
  uiReadSettingsFile: "ui_read_settings_file",
  sessionOpenReviewManagement: "session_open_review_management",
  readGetServerStatus: "read_get_server_status",
  readListSupportedProtocols: "read_list_supported_protocols",
  readListDeepbookPools: "read_list_deepbook_pools",
  readListDeepbookTokens: "read_list_deepbook_tokens",
  readInspectDeepbookOrderbook: "read_inspect_deepbook_orderbook",
  readGetDeepbookMidPrice: "read_get_deepbook_mid_price",
  readGetDeepbookUsdcPriceHistory: "read_get_deepbook_usdc_price_history",
  readGetDeepbookUsdcPriceAtTime: "read_get_deepbook_usdc_price_at_time",
  readQuoteDeepbookAction: "read_quote_deepbook_action",
  readQuoteDeepbookDisplayAmount: "read_quote_deepbook_display_amount",
  readSummarizeDeepbookAccountInventory: "read_summarize_deepbook_account_inventory",
  readSummarizeWalletAssets: "read_summarize_wallet_assets",
  readClassifyWalletAssets: "read_classify_wallet_assets",
  readListSettlementAssetGroups: "read_list_settlement_asset_groups",
  readSummarizeSettlementAssetGroupParity: "read_summarize_settlement_asset_group_parity",
  readPreviewIntentEvidence: "read_preview_intent_evidence",
  readListReviewActivity: "read_list_review_activity",
  readSummarizeReviewFunnel: "read_summarize_review_funnel",
  readGetReviewSessionDetail: "read_get_review_session_detail",
  readInspectSuiTransaction: "read_inspect_sui_transaction",
  readScanSuiAccountActivity: "read_scan_sui_account_activity",
  readSummarizeSuiActivityScan: "read_summarize_sui_activity_scan",
  readScanSuiFunctionActivity: "read_scan_sui_function_activity",
  readSummarizeSuiFunctionActivityScan: "read_summarize_sui_function_activity_scan",
  readSummarizeSuiAccountActivity: "read_summarize_sui_account_activity",
  readGetAccountAssetTimeline: "read_get_account_asset_timeline",
  settingsCreateLocalSettingsSession: "settings_create_local_settings_session",
  settingsGetLocalSettings: "settings_get_local_settings",
  actionStartReview: "action_start_review",
  actionCreateProposalReview: "action_create_proposal_review",
  sessionOpenWalletConnectionCard: "session_open_wallet_connection_card",
  sessionGetWalletConnectionCard: "session_get_wallet_connection_card",
  sessionWaitWalletConnectionCard: "session_wait_wallet_connection_card",
  sessionGetInteractionStatus: "session_get_interaction_status",
  sessionGetReviewStatus: "session_get_review_status",
  sessionGetExecutionResult: "session_get_execution_result",
  sessionWaitExecutionResult: "session_wait_execution_result",
  accountGetActiveAccount: "account_get_active_account"
} as const;

export function assertValidToolName(name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new Error(`Invalid MCP tool name: ${name}`);
  }
}

export function assertAllToolNamesValid(): void {
  for (const name of Object.values(TOOL_NAMES)) {
    assertValidToolName(name);
  }
}
