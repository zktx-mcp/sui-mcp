import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING } from "../core/read/deepbookSourceOwners.js";
import { TOOL_NAMES } from "./toolNames.js";

type PackageMetadata = {
  name: string;
  version: string;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageMetadata = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8")
) as PackageMetadata;

export const PACKAGE_NAME = packageMetadata.name;
export const SERVER_NAME = "sui-mcp";
export const SERVER_VERSION = packageMetadata.version;
export const SERVER_NETWORK = "mainnet";
export const SERVER_RUNTIME = "local_stdio";
export const SERVER_TRANSPORT = "grpc_graphql";
export const USD_INTENT_ANSWER_REQUIRED_TOOLS = [
  TOOL_NAMES.readGetServerStatus,
  TOOL_NAMES.readListSettlementAssetGroups,
  TOOL_NAMES.readPreviewIntentEvidence
] as const;
export const USD_PARITY_ANSWER_REQUIRED_TOOLS = [
  TOOL_NAMES.readGetServerStatus,
  TOOL_NAMES.readListSettlementAssetGroups,
  TOOL_NAMES.readSummarizeSettlementAssetGroupParity
] as const;
export const EVIDENCE_POLICY = {
  version: "intent-evidence-alpha-2026-05-23",
  releaseGate: "intent_evidence_v1",
  requiredFirstCheck: true,
  requiredStatusFields: [
    "packageName",
    "version",
    "evidencePolicy.version",
    "network",
    "implementedToolsCount"
  ],
  gates: [
    "server_status_version_check",
    "natural_language_settlement_asset_group_evidence",
    "sdk_sot_no_duplicate_registry_or_amount_parser",
    "requested_account_inference_policy",
    "wallet_balance_snapshot_not_receipt_proof",
    "deepbook_quote_no_fiat_or_route_inference",
    "pnl_unsupported"
  ]
} as const;

export const SERVER_INSTRUCTIONS = [
  "Sui MCP is a mainnet-only Sui DeFi intent evidence toolkit. Ordinary MCP tools return evidence or internal cards, never signing authority, bytes or signatures. Only user card selection and wallet approval authorize the backend WalletConnect flow: verify reviewed digest and signer, submit once, then read chain effects. Request status is separate from chain success/failure; uncertain results are read by digest, never resubmitted.",
  "External proposals are untrusted facts; plans[].reviewModel is review context, not transaction material, route/settlement choice, signing/readiness, or execution readiness.",
  "PTB graphs are diagnostics only; not transaction input, wallet authorization, signing/readiness, execution readiness, route quality, or safety.",
  "Use response-local fields: userAnswerUse.answerFields/preconditionFields/conclusionRuleFields/cannotAnswer/diagnosticOnlyFields/followUp, pollingHint, and quantitySemantics.",
  "For USD-denominated payment coverage, balance total, or shortfall questions, call read.get_server_status, then read.list_settlement_asset_groups, then read.preview_intent_evidence. Use toolAvailability.requiredToolsAvailable and responseSummary.doNotCallQuoteToolsForThisQuestion; do not call wallet inventory or quote tools unless user asks a separate inventory or conversion question. For parity, use read.summarize_settlement_asset_group_parity. If toolAvailability cannot be used, say the current MCP server build cannot support the answer.",
  "The active account context is read-only, not login, custody or signing permission. Implicit asset reads require session.get_interaction_status.assetReadAccount: available. Otherwise ask for an address only if the tool accepts account; connected-only tools require connection/account selection or wallet recovery.",
  "Unsupported: other chains, autonomous trading, alerts, investment advice, arbitrary Move/package calls, P&L/tax.",
  "One wallet connection at a time; docs: suimcp://docs/agent-behavior, suimcp://docs/mcp-tools."
].join("\n");

export const IMPLEMENTED_TOOLS = [
  TOOL_NAMES.uiOpenAccount, TOOL_NAMES.uiOpenReceipt, TOOL_NAMES.uiOpenChart,
  TOOL_NAMES.uiReadCard, TOOL_NAMES.uiSubmitCard, TOOL_NAMES.uiActCard, TOOL_NAMES.uiReadSettingsFile,
  TOOL_NAMES.readGetServerStatus,
  TOOL_NAMES.readListSupportedProtocols,
  TOOL_NAMES.readListDeepbookPools,
  TOOL_NAMES.readListDeepbookTokens,
  TOOL_NAMES.readInspectDeepbookOrderbook,
  TOOL_NAMES.readGetDeepbookMidPrice,
  TOOL_NAMES.readGetDeepbookUsdcPriceHistory,
  TOOL_NAMES.readGetDeepbookUsdcPriceAtTime,
  TOOL_NAMES.readQuoteDeepbookAction,
  TOOL_NAMES.readQuoteDeepbookDisplayAmount,
  TOOL_NAMES.readSummarizeDeepbookAccountInventory,
  TOOL_NAMES.readSummarizeWalletAssets,
  TOOL_NAMES.readClassifyWalletAssets,
  TOOL_NAMES.readListSettlementAssetGroups,
  TOOL_NAMES.readSummarizeSettlementAssetGroupParity,
  TOOL_NAMES.readPreviewIntentEvidence,
  TOOL_NAMES.readListReviewActivity,
  TOOL_NAMES.readSummarizeReviewFunnel,
  TOOL_NAMES.readGetReviewSessionDetail,
  TOOL_NAMES.readInspectSuiTransaction,
  TOOL_NAMES.readScanSuiAccountActivity,
  TOOL_NAMES.readSummarizeSuiActivityScan,
  TOOL_NAMES.readScanSuiFunctionActivity,
  TOOL_NAMES.readSummarizeSuiFunctionActivityScan,
  TOOL_NAMES.readSummarizeSuiAccountActivity,
  TOOL_NAMES.readGetAccountAssetTimeline,
  TOOL_NAMES.settingsCreateLocalSettingsSession,
  TOOL_NAMES.settingsGetLocalSettings,
  TOOL_NAMES.actionPrepareSuiActionReview,
  TOOL_NAMES.actionPrepareExternalProposalReview,
  TOOL_NAMES.accountGetActiveAccount,
  TOOL_NAMES.sessionCreateWalletConnection,
  TOOL_NAMES.sessionGetWalletConnection,
  TOOL_NAMES.sessionWaitWalletConnection,
  TOOL_NAMES.sessionOpenReviewManagement,
  TOOL_NAMES.sessionGetInteractionStatus,
  TOOL_NAMES.sessionGetReviewStatus,
  TOOL_NAMES.sessionGetExecutionResult,
  TOOL_NAMES.sessionWaitExecutionResult
] as const;

export const FAIL_CLOSED_TOOLS = [] as const;

export type ToolAvailability = {
  statusTool: typeof TOOL_NAMES.readGetServerStatus;
  packageName: typeof PACKAGE_NAME;
  version: string;
  evidencePolicyVersion: typeof EVIDENCE_POLICY.version;
  network: typeof SERVER_NETWORK;
  implementedToolsCount: number;
  requiredTools: Array<{ name: string; available: boolean }>;
  missingRequiredTools: string[];
  requiredToolsAvailable: boolean;
  unavailableReason: "required_tool_missing_from_current_server_build" | null;
};

export function toolAvailability(requiredTools: readonly string[]): ToolAvailability {
  const implemented = new Set<string>(IMPLEMENTED_TOOLS);
  const missingRequiredTools = requiredTools.filter((tool) => !implemented.has(tool));
  return {
    statusTool: TOOL_NAMES.readGetServerStatus,
    packageName: PACKAGE_NAME,
    version: SERVER_VERSION,
    evidencePolicyVersion: EVIDENCE_POLICY.version,
    network: SERVER_NETWORK,
    implementedToolsCount: IMPLEMENTED_TOOLS.length,
    requiredTools: requiredTools.map((name) => ({ name, available: implemented.has(name) })),
    missingRequiredTools,
    requiredToolsAvailable: missingRequiredTools.length === 0,
    unavailableReason:
      missingRequiredTools.length === 0 ? null : "required_tool_missing_from_current_server_build"
  };
}

export const SERVER_LIMITATIONS = [
  "Current asset reads without a user-provided address require a selected account with a usable current wallet connection. session.get_interaction_status.assetReadAccount reports whether that default is available. Only tools with an account input accept explicit addresses; DeepBook account inventory requires a connected selected account. Explicit-address coin balance reads are public-address snapshots and do not create active account context. Active account is read context only, not signing authorization, login, custody, or persistent permission.",
  "Review activity tools summarize local Sui MCP review evidence only. Sui activity tools use user-requested bounded GraphQL reads and store normalized transaction facts only for known wallet context; function activity scans are sent-transaction scans only. They are not background indexers, complete history, balance history, complete gas history, affected-object history, or P&L.",
  `read.get_account_asset_timeline reads stored local account activity facts and returns observed raw net-flow bars with scan coverage. It does not start scans, prove complete wallet history, provide held balances without balanceBars, compute USD value, P&L, tax, cost basis, route advice, transaction-building input, signing data, or signing readiness. Optional USDC references are token-denominated ${DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.officialIndexerCandleReferences} only, ${DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.usdcNotFiatUsdAndNotPeg}.`,
  "Sui activity transactionContext facts are transaction-level facts without transaction-wide balance-change aggregates, and they are answer fields only when the response returns them. requestedAccountTransactionFacts, requestedAccount, and requestedAccountEffect are the account-specific balance-change surfaces. Activity quantitySemantics marks balance amountRaw fields as raw integers that require verified decimals for display conversion. accountBalanceChangeInferencePolicy marks whether returned account balance rows can be used or transaction-level context must not be used for account amount inference. Gas raw fields use MIST, and returned gasCost display facts use @mysten/sui MIST_PER_SUI.",
  "Wallet asset classification covers only current coin balances returned by Sui gRPC listBalances for an explicit address or the active account. Wallet balance quantitySemantics marks those reads as current snapshots, not transaction history, receipt proof, acquisition source, object provenance, P&L, cost basis, or signing material. DeepBook account inventory is a separate active-account read surface; neither surface creates routes, funding plans, portfolio plans, or signing material.",
  "High-risk read responses include userAnswerUse. Prefer userAnswerUse.preconditionFields before answering, userAnswerUse.answerFields for the answer path, userAnswerUse.conclusionRuleFields for conclusion limits, userAnswerUse.diagnosticOnlyFields for source or troubleshooting context, and userAnswerUse.followUp when a different tool and field are required. USD intent and parity responses also include toolAvailability as a precondition field for current server-build support.",
  "Intent evidence maps natural-language USD-denominated targets to pinned DeepBook SDK settlement asset groups and current wallet balance evidence. responseSummary.answerCompleteness names the answer class and required fields. Settlement-asset-only answers use responseSummary; selected-target evidence requires user selection provenance and also uses selectedTarget, candidateConversions, and requiredUserChoices when userAnswerUse.answerFields lists them. Direct pool quote evidence is returned and supported only when a quoted candidate exists. responseSummary.doNotUseForConclusion names quote results, outside-settlement-group assets, and route-dependent support as excluded from the conclusion. Intent evidence does not silently choose settlement assets, rank venues or routes, evaluate gas reserve, build transactions, or produce signing material.",
  "DeepBook quotes convert explicit raw or display source inputs through pinned token units and return scoped SDK simulation facts plus raw quote evidence. Their quantitySemantics says canUseForPaymentAnswer and canUseForShortfallAnswer are false, doNotCombineWithPaymentAnswer is true, requiredPaymentAnswerTool is read.preview_intent_evidence, and requiredPaymentAnswerField is responseSummary.",
  "Action preparation returns internal Review cards. A current card with valid UI permission automatically prepares and renews verified conditions for one selected wallet/account; only the explicit Request wallet approval action can request a signature. Supported DeepBook account-bound swap review verifies stored transaction material, digest, ownership, quote/policy, human-readable facts, simulation and PTB evidence. Only a scoped app-only user action and wallet approval authorize the backend WalletConnect request; ordinary MCP calls never sign or submit. Transaction bytes and signatures never enter card/model results. The backend verifies returned transaction digest and signer, submits once, and independently reads chain effects. requestStatus is separate from chain execution success/failure: stopped, request_failed and outcome_unknown do not prove a chain failure. Lost replies are resolved by reading the same request/digest, never automatic resubmission. External proposals remain non-signable. Receipts do not establish execution guarantees, route quality, fiat value, P&L, tax, peg proof or best-price advice.",
  "read.list_deepbook_pools and read.list_deepbook_tokens return static SDK registry metadata, not live liquidity, live token discovery, or active pool state.",
  `DeepBook orderbook, mid-price, and quote outputs are ${DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.pinnedSdkSnapshots} at fetchedAt; treat them as stale if the user delays.`,
  `DeepBook USDC price history and price-at-time reads use ${DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.officialIndexerCandleData} for the requested official interval. They are external candle evidence only, not live quotes, historical mid prices, global market prices, fiat USD values, USDC/USD peg guarantees, route recommendations, transaction-building inputs, signing readiness, P&L, cost basis, user-account transaction history, or user-account balance history. Sui MCP does not independently recompute those candle values from chain history for the response.`,
  `ui.open_chart displays ${DEEPBOOK_SOURCE_OWNER_RUNTIME_WORDING.officialIndexerUsdcDenominatedCandles} in an internal read-only card. ui.open_account displays a public-address asset snapshot; ui.open_receipt displays the executed transaction graph when bound UI metadata is available, followed by on-chain facts and a Details slide. Card inputs end after backend admission, expiry or invalidation; chat navigation and frame recreation do not end valid unsubmitted input. Read the same DB state after a lost reply rather than resubmitting. Saved results do not authorize a new query or transaction. These cards are not live feeds, trading interfaces, route recommendations, fiat USD value, P&L, tax, cost basis, signing data, or signing readiness.`,
  "Settings uses an internal card. MCP settings tools create the card or read current settings; only the user's scoped card confirmation applies local changes or restarts the connection service. Backup bytes stay in app-only file transfer. No external Settings URL exists."
] as const;
