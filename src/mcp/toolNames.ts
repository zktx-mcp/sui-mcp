export const TOOL_NAMES = {
  uiOpenAccount: "ui.open_account",
  uiOpenReceipt: "ui.open_receipt",
  uiOpenChart: "ui.open_chart",
  uiReadCard: "ui.read_card",
  uiSubmitCard: "ui.submit_card",
  uiActCard: "ui.act_card",
  uiReadSettingsFile: "ui.read_settings_file",
  sessionOpenReviewManagement: "session.open_review_management",
  readGetServerStatus: "read.get_server_status",
  readListSupportedProtocols: "read.list_supported_protocols",
  readListDeepbookPools: "read.list_deepbook_pools",
  readListDeepbookTokens: "read.list_deepbook_tokens",
  readInspectDeepbookOrderbook: "read.inspect_deepbook_orderbook",
  readGetDeepbookMidPrice: "read.get_deepbook_mid_price",
  readGetDeepbookUsdcPriceHistory: "read.get_deepbook_usdc_price_history",
  readGetDeepbookUsdcPriceAtTime: "read.get_deepbook_usdc_price_at_time",
  readQuoteDeepbookAction: "read.quote_deepbook_action",
  readQuoteDeepbookDisplayAmount: "read.quote_deepbook_display_amount",
  readSummarizeDeepbookAccountInventory: "read.summarize_deepbook_account_inventory",
  readSummarizeWalletAssets: "read.summarize_wallet_assets",
  readClassifyWalletAssets: "read.classify_wallet_assets",
  readListSettlementAssetGroups: "read.list_settlement_asset_groups",
  readSummarizeSettlementAssetGroupParity: "read.summarize_settlement_asset_group_parity",
  readPreviewIntentEvidence: "read.preview_intent_evidence",
  readListReviewActivity: "read.list_review_activity",
  readSummarizeReviewFunnel: "read.summarize_review_funnel",
  readGetReviewSessionDetail: "read.get_review_session_detail",
  readInspectSuiTransaction: "read.inspect_sui_transaction",
  readScanSuiAccountActivity: "read.scan_sui_account_activity",
  readSummarizeSuiActivityScan: "read.summarize_sui_activity_scan",
  readScanSuiFunctionActivity: "read.scan_sui_function_activity",
  readSummarizeSuiFunctionActivityScan: "read.summarize_sui_function_activity_scan",
  readSummarizeSuiAccountActivity: "read.summarize_sui_account_activity",
  readGetAccountAssetTimeline: "read.get_account_asset_timeline",
  settingsCreateLocalSettingsSession: "settings.create_local_settings_session",
  settingsGetLocalSettings: "settings.get_local_settings",
  actionPrepareSuiActionReview: "action.prepare_sui_action_review",
  actionPrepareExternalProposalReview: "action.prepare_external_proposal_review",
  sessionCreateWalletConnection: "session.create_wallet_connection",
  sessionGetWalletConnection: "session.get_wallet_connection",
  sessionWaitWalletConnection: "session.wait_wallet_connection",
  sessionGetInteractionStatus: "session.get_interaction_status",
  sessionGetReviewStatus: "session.get_review_status",
  sessionGetExecutionResult: "session.get_execution_result",
  sessionWaitExecutionResult: "session.wait_execution_result",
  accountGetActiveAccount: "account.get_active_account"
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
