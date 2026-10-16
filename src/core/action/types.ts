import type { UserAnswerUse } from "../evidence/userAnswerUse.js";
import type { ProposalReviewModel } from "../proposal/types.js";
import type { LocalSessionBase } from "../session/localSession.js";
import type { PtbVisualizationArtifact, TransactionReviewData } from "./signableAdapterContract.js";
export type { TransactionExecutionSummary } from "../session/transactionRequest.js";
export {
  SUI_CHAIN_RECEIPT_REQUIRED_INCLUDE,
  type SuiChainReceiptAccountBalanceChange,
  type SuiChainReceiptEffectsStatus,
  type SuiChainReceiptEvidence,
  type SuiChainReceiptIncludeField,
  type SuiChainReceiptPackageCall,
  type SuiChainReceiptSource
} from "./suiChainReceiptEvidence.js";

export type UnknownRecord = Record<string, unknown>;

export const BLOCKED_REASONS = [
  "adapter_not_implemented",
  "producer_stage_missing",
  "wallet_review_contract_emit_missing",
  "network_mismatch",
  "insufficient_balance",
  "insufficient_gas",
  "allowlist_violation",
  "asset_mismatch",
  "amount_mismatch",
  "wallet_mismatch",
  "unsupported_action",
  "object_resolution_failed",
  "proposal_review_only"
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const REFRESH_REASONS = [
  "review_evidence_stale",
  "quote_stale",
  "quote_unavailable",
  "simulation_transient_failure",
  "review_update_failed",
  "wallet_connection_changed"
] as const;

export type RefreshReason = (typeof REFRESH_REASONS)[number];

export type ReviewStatus =
  | "ready_for_wallet_review"
  | "refresh_required"
  | "blocked";

export const REVIEW_PREPARATION_STATUSES = ["proposed", "awaiting_wallet", "wallet_connected", "ready_for_wallet_review", "refresh_required", "blocked", "expired"] as const;
export type InternalSessionStatus = (typeof REVIEW_PREPARATION_STATUSES)[number];

export type ReviewCheckSource =
  | "registry"
  | "quote"
  | "wallet"
  | "simulation"
  | "adapter"
  | "network"
  | "proposal";

export type ReviewCheck = {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  message: string;
  source: ReviewCheckSource;
};

export type AdapterLifecycle = {
  stageCatalogId: string;
  adapterId: string;
  protocol: string;
  actionKind: string;
  completedStages: string[];
  missingStages: string[];
};

export type AssetAmount = {
  symbol: string;
  amount: string;
  coinType?: string;
  approx?: boolean;
};

export type DisplayIntentAssetAmount = AssetAmount & {
  amountKind: "display_intent";
};

export type AssetFlowPreview = {
  outgoing: DisplayIntentAssetAmount[];
  expectedIncoming: DisplayIntentAssetAmount[];
  minimumIncoming?: DisplayIntentAssetAmount[];
  fees?: DisplayIntentAssetAmount[];
};

export type AssetFlow = {
  outgoing: AssetAmount[];
  expectedIncoming: AssetAmount[];
  minimumIncoming?: AssetAmount[];
  fees?: AssetAmount[];
};

export type BalanceChange = {
  before: AssetAmount[];
  after: AssetAmount[];
  delta: AssetAmount[];
};

export type TransactionSimulationGasCostSummary = {
  computationCostRaw: string;
  storageCostRaw: string;
  storageRebateRaw: string;
  nonRefundableStorageFeeRaw: string;
};

export type TransactionSimulationBalanceChange = {
  address: string;
  coinType: string;
  amount: string;
};

export type TransactionSimulationObjectChange = {
  objectId: string;
  objectType?: string | undefined;
  inputState: string;
  outputState: string;
  idOperation: string;
};

export type TransactionSimulationSummary = {
  provider: "client.core.simulateTransaction" | "client.transactionExecutionService.simulateTransaction";
  checksEnabled: boolean;
  success: boolean;
  gasCostSummary?: TransactionSimulationGasCostSummary;
  balanceChanges?: TransactionSimulationBalanceChange[];
  objectChanges?: TransactionSimulationObjectChange[];
  error?: string;
};

export type SuccessfulTransactionSimulationSummary = TransactionSimulationSummary & {
  checksEnabled: true;
  success: true;
  gasCostSummary: TransactionSimulationGasCostSummary;
  balanceChanges: TransactionSimulationBalanceChange[];
  objectChanges: TransactionSimulationObjectChange[];
  error?: never;
};

export type SwapHumanReadableReviewAmount = {
  role: "input" | "expected_output" | "minimum_output" | "fee";
  symbol: string;
  coinType: string;
  decimals: number;
  rawAmount: string;
  rawAmountSource: "quote_policy_evidence";
  displayAmount?: string | undefined;
  displayAmountSource?: "user_display_intent_not_signing_input" | undefined;
};

export type HumanReadableReviewParty = {
  role: "connected_account" | "output_recipient";
  address: string;
};

export type SwapHumanReadableReviewTarget = {
  kind: "swap_output_asset";
  symbol: string;
  coinType: string;
  protocol: string;
  poolKey: string;
  direction: "base_to_quote" | "quote_to_base";
};

export type HumanReadableReviewFact = {
  id: string;
  label: string;
  source: ReviewCheckSource | "transaction_material" | "digest_commitment";
  summary: string;
};

export type HumanReadableReviewGap = {
  id: string;
  label: string;
  reason: string;
};

export type HumanReadableReviewEnvelope = {
  proposedAction: {
    title: string;
    summary: string;
    actionKind: string;
    adapterId: string;
    protocol: string;
    network: "sui:mainnet";
  };
  recipients: HumanReadableReviewParty[];
  evidenceUsed: HumanReadableReviewFact[];
  missingEvidence: HumanReadableReviewGap[];
  requiredUserChoices: HumanReadableReviewGap[];
  unsupportedClaims: HumanReadableReviewGap[];
  freshness: {
    status: "current";
    evaluatedAt: string;
    expiresAt: string;
    reason: string;
  };
  blockingChecks: ReviewCheck[];
};

export type HumanReadableReviewSummaryBase<TKind extends string> =
  HumanReadableReviewEnvelope & {
    kind: TKind;
  };

export type SwapHumanReadableReviewProjection = {
  assetFlow: {
    outgoing: SwapHumanReadableReviewAmount[];
    expectedIncoming: SwapHumanReadableReviewAmount[];
    minimumIncoming: SwapHumanReadableReviewAmount[];
    fees: SwapHumanReadableReviewAmount[];
  };
  targets: SwapHumanReadableReviewTarget[];
};

export type SwapHumanReadableReviewSummary =
  HumanReadableReviewSummaryBase<"swap_human_readable_review"> &
  SwapHumanReadableReviewProjection;

export type HumanReadableReviewSummary = SwapHumanReadableReviewSummary;

export type ActionPlan<TAdapterData extends UnknownRecord = UnknownRecord> = {
  id: string;
  actionKind: string;
  adapterId: string;
  protocol: string;
  title: string;
  summary: string;
  assetFlowPreview: AssetFlowPreview;
  reviewModel?: ProposalReviewModel;
  adapterData: TAdapterData;
  createdAt: string;
  expiresAt?: string;
  registryVersion?: string;
  preliminaryChecks?: ReviewCheck[];
};

export const REVIEW_MATERIAL_DERIVED_FIELDS = ["humanReadableReview", "simulation", "transactionReviewData",
  "ptbVisualization", "assetFlowActual", "beforeAfterBalance"] as const;

type ReviewStateBase = {
  planId: string;
  reviewSessionId: string;
  account: string;
  checks: ReviewCheck[];
  assetFlowActual?: AssetFlow;
  beforeAfterBalance?: BalanceChange;
  simulation?: TransactionSimulationSummary;
  humanReadableReview?: HumanReadableReviewSummary;
  transactionReviewData?: TransactionReviewData;
  ptbVisualization?: PtbVisualizationArtifact;
  adapterLifecycle?: AdapterLifecycle;
  updatedAt: string;
};

export type ReviewState =
  | (ReviewStateBase & {
      status: "ready_for_wallet_review";
      evidenceValidity?: never;
      blockedReason?: never;
      refreshReason?: never;
    })
  | (ReviewStateBase & {
      status: "refresh_required";
      evidenceValidity?: "invalidated";
      refreshReason: RefreshReason;
      blockedReason?: never;
    })
  | (ReviewStateBase & {
      status: "blocked";
      evidenceValidity?: "invalidated";
      blockedReason: BlockedReason;
      refreshReason?: never;
    });

export type ReviewSession = LocalSessionBase & {
  ownerId: string;
  reviewRevision: number;
  // Identifies an admitted preparation awaiting a stored outcome.
  preparationId?: string;
  // A saved preparation failure or connection-change message. It does not
  // prove that a computation ran, nor describe current action permission.
  preparationError?: string;
  walletConnectionId?: string;
  walletGrantRevision?: number;
  currentAttemptId?: string;
  status: InternalSessionStatus;
  plans: ActionPlan[];
  account?: string;
  reviewState?: ReviewState;
};

export type ToolErrorKind =
  | "wallet_unavailable"
  | "ui_unavailable"
  | "input_invalid"
  | "registry_miss"
  | "unsupported_action"
  | "network_mismatch"
  | "quote_unavailable"
  | "blocked"
  | "session_not_found"
  | "active_account_not_set"
  | "session_expired"
  | "invalid_session_transition"
  | "plan_not_in_session"
  | "session_mismatch"
  | "handoff_unavailable"
  | "handoff_commitment_mismatch"
  | "request_aborted"
  | "metadata_cache_unavailable"
  | "internal_error";

export type ToolError = {
  kind: ToolErrorKind;
  details: UnknownRecord;
};

export type McpActionResponse = {
  reviewSessionId: string;
  card: import("../session/cardSession.js").CardSnapshot;
  plans: ActionPlan[];
  preliminaryChecks: ReviewCheck[];
  userAnswerUse: UserAnswerUse;
};

export type McpToolPayload<T extends UnknownRecord = UnknownRecord> = {
  ok: true;
  data: T;
};

export type McpToolErrorPayload = {
  ok: false;
  error: ToolError;
};

export type McpToolResponse<T extends UnknownRecord = UnknownRecord> =
  | McpToolPayload<T>
  | McpToolErrorPayload;

// Display wording for the three computed review states, not wallet authority.
export const REVIEW_UI_LABELS: Record<ReviewStatus, string> = {
  ready_for_wallet_review: "Ready for your review",
  refresh_required: "Review needs updating",
  blocked: "Review blocked"
};
