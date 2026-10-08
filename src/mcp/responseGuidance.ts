import type { UserAnswerUse } from "../core/evidence/userAnswerUse.js";
import { EXTERNAL_PROPOSAL_SETTLEMENT_TOKEN_SELECTION_UNSUPPORTED_CLAIM_ID } from "../core/proposal/types.js";
import { TOOL_NAMES } from "./toolNames.js";

export function interactionStatusUserAnswerUse(hasWalletObservation = false, hasConnectionConflict = false, reconciliationRequired = false): UserAnswerUse {
  return {
    canAnswer: [
      "stored_active_account_read_context",
      "wallet_connections_when_wallet_availability_is_available",
      "connection_qualified_default_asset_account",
      "pending_local_wallet_connection_interactions",
      ...(hasConnectionConflict ? ["multiple_saved_connections_require_user_targeted_disconnection"] : []),
      ...(reconciliationRequired ? ["unrecorded_service_connection_requires_wallet_removal_and_confirmed_absence"] : []),
      "pending_local_review_interactions",
      "wallet_operation_availability_separate_from_stored_transaction_facts"
    ],
    cannotAnswer: [
      "wallet_login_or_authentication",
      "implicit_default_unavailability_as_explicit_address_support_for_every_tool",
      "wallet_custody_or_authorization",
      "wallet_unavailability_as_chain_failure_or_lost_stored_result",
      "last_service_observation_as_live_wallet_app_state",
      "sdk_availability_or_recorded_connection_as_account_use_or_signing_authority",
      "transaction_execution_result",
      "transaction_building",
      "signing_data_or_readiness",
      "complete_wallet_history",
      "profit_or_pnl"
    ],
    preconditionFields: ["walletAvailability", "assetReadAccount", ...(hasConnectionConflict ? ["connectionConflict"] : []),
      ...(reconciliationRequired ? ["connectionReconciliationRequired"] : [])],
    answerFields: ["activeAccount", "connections", "assetReadAccount", "pendingWalletConnections", "pendingReviewSessions", "walletAvailability",
      ...(hasConnectionConflict ? ["connectionConflict"] : []),
      "manageableConnectionIds", ...(reconciliationRequired ? ["connectionReconciliationRequired"] : []),
      ...(hasWalletObservation ? ["walletObservation"] : [])],
    diagnosticOnlyFields: [
      "pendingWalletConnections.truncated",
      "pendingReviewSessions.truncated"
    ],
    followUp: {
      tool: TOOL_NAMES.sessionGetReviewStatus,
      inputFields: ["pendingReviewSessions.items[].reviewSessionId"],
      answerFields: ["pollingStatus", "statusCategory", "reviewState"],
      reason: "Read one review's stored preparation and request facts. The overview lists live input or ongoing work; cancelled input alone is not pending."
    }
  };
}

export function executionResultUserAnswerUse(
  fields: { hasExecutionResult?: boolean; hasWaitOutcome?: boolean; hasRequest?: boolean; hasConnectionConflict?: boolean; reconciliationRequired?: boolean } = {}
): UserAnswerUse {
  const hasExecutionResult = fields.hasExecutionResult ?? false;
  const hasWaitOutcome = fields.hasWaitOutcome ?? false;

  return {
    canAnswer: [
      "current_local_execution_polling_status",
      "whether_user_action_or_chain_polling_is_still_pending",
      "wallet_operation_availability_separate_from_stored_transaction_facts",
      ...(hasExecutionResult ? ["recorded_review_execution_result"] : [])
    ],
    cannotAnswer: [
      ...(hasExecutionResult ? [] : ["recorded_review_execution_result_without_executionResult_field"]),
      "transaction_execution_guarantee",
      "chain_receipt_as_execution_guarantee",
      "chain_receipt_as_route_quality",
      "chain_receipt_as_fiat_pnl_tax_or_peg_evidence",
      "absolute_safety_verdict",
      "route_quality",
      "wallet_custody_or_authorization",
      "wallet_unavailability_as_chain_failure_or_lost_stored_result",
      "transaction_building",
      "signing_data_or_readiness",
      "complete_wallet_history",
      "profit_or_pnl"
    ],
    answerFields: [
      "walletAvailability", "progress", ...(fields.hasConnectionConflict ? ["connectionConflict"] : []),
      ...(fields.reconciliationRequired ? ["connectionReconciliationRequired"] : []), ...(hasWaitOutcome ? ["waitOutcome"] : []),
      "reviewSessionId",
      "status",
      "pollingStatus",
      "statusCategory",
      "lastActivityAt",
      "pollingHint",
      ...(fields.hasRequest ? ["attemptId", "requestStatus", "request"] : []),
      ...(hasExecutionResult ? ["executionResult"] : [])
    ],
    conclusionRuleFields: [
      "walletAvailability.status", "progress.status",      "statusCategory",
      "pollingHint.finalStatuses",
      "pollingHint.userActionRequiredStatuses",
      "pollingHint.nonTerminalStatuses"
    ],
    diagnosticOnlyFields: [],
    followUp: {
      tool: TOOL_NAMES.sessionGetReviewStatus,
      inputFields: ["reviewSessionId"],
      answerFields: ["pollingStatus", "statusCategory", "reviewState"],
      reason: "Use for current review state and checks. Wallet availability describes backend operations, not authorization. An unavailable wait retains stored facts and does not prove chain failure."
    }
  };
}

export function reviewStatusUserAnswerUse(
  hasReviewState: boolean,
  hasAdapterLifecycle = false,
  hasHumanReadableReview = false,
  hasSimulation = false,
  hasConnectionConflict = false,
  reconciliationRequired = false
): UserAnswerUse {
  return {
    canAnswer: [
      "current_local_review_session_status",
      "current_review_checks_when_reviewState_is_present",
      ...(hasAdapterLifecycle ? ["current_adapter_review_lifecycle_stage_status"] : []),
      ...(hasHumanReadableReview ? ["current_human_readable_review_facts_projected_from_verified_review_evidence"] : []),
      ...(hasSimulation ? ["current_review_time_simulation_summary_projected_from_private_review_evidence"] : []),
      "whether_user_action_or_chain_polling_is_still_pending",
      "wallet_operation_availability_separate_from_stored_transaction_facts"
    ],
    cannotAnswer: [
      "transaction_execution_guarantee",
      "absolute_safety_verdict",
      "route_quality",
      "wallet_custody_or_authorization",
      "wallet_unavailability_as_chain_failure_or_lost_stored_result",
      "transaction_building",
      "transaction_bytes_or_signatures",
      "signing_data_or_readiness",
      "complete_wallet_history",
      "profit_or_pnl"
    ],
    answerFields: [
      "walletAvailability", "progress", ...(hasConnectionConflict ? ["connectionConflict"] : []),
      ...(reconciliationRequired ? ["connectionReconciliationRequired"] : []), "reviewSessionId",
      "status",
      "pollingStatus",
      "statusCategory",
      ...(hasReviewState
        ? [
            "reviewState.status",
            "reviewState.checks",
            "reviewState.blockedReason",
            "reviewState.refreshReason"
          ]
        : []),
      ...(hasAdapterLifecycle
        ? [
            "reviewState.adapterLifecycle",
            "reviewState.adapterLifecycle.stageCatalogId",
            "reviewState.adapterLifecycle.completedStages",
            "reviewState.adapterLifecycle.missingStages"
          ]
        : []),
      ...(hasHumanReadableReview
        ? [
            "reviewState.humanReadableReview",
            "reviewState.humanReadableReview.kind",
            "reviewState.humanReadableReview.proposedAction",
            "reviewState.humanReadableReview.assetFlow",
            "reviewState.humanReadableReview.targets",
            "reviewState.humanReadableReview.evidenceUsed",
            "reviewState.humanReadableReview.missingEvidence",
            "reviewState.humanReadableReview.requiredUserChoices",
            "reviewState.humanReadableReview.freshness",
            "reviewState.humanReadableReview.unsupportedClaims",
            "reviewState.humanReadableReview.blockingChecks"
          ]
        : []),
      ...(hasSimulation
        ? [
            "reviewState.simulation",
            "reviewState.simulation.provider",
            "reviewState.simulation.checksEnabled",
            "reviewState.simulation.success",
            "reviewState.simulation.gasCostSummary",
            "reviewState.simulation.gasCostSummary.computationCostRaw",
            "reviewState.simulation.gasCostSummary.storageCostRaw",
            "reviewState.simulation.gasCostSummary.storageRebateRaw",
            "reviewState.simulation.gasCostSummary.nonRefundableStorageFeeRaw",
            "reviewState.simulation.balanceChanges",
            "reviewState.simulation.objectChanges"
          ]
        : []),
      "lastActivityAt"
    ],
    diagnosticOnlyFields: [],
    followUp: {
      tool: TOOL_NAMES.sessionGetExecutionResult,
      inputFields: ["reviewSessionId"],
      answerFields: ["executionResult"],
      reason: "Use when the user asks for a recorded execution result; status alone is not transaction execution proof."
    }
  };
}

export function reviewActivityListUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: ["local_review_session_rows_for_the_selected_account", "current_stored_review_status_counts_by_row"],
    cannotAnswer: [
      "sui_wallet_transaction_history",
      "complete_wallet_history",
      "execution_result_detail",
      "transaction_building",
      "signing_data_or_readiness",
      "profit_or_pnl"
    ],
    answerFields: ["activities", "activities[].reviewSessionId", "activities[].reviewStatus", "activities[].updatedAt"],
    diagnosticOnlyFields: ["dataScope", "accountSource", "lowSampleWarning", "lowSampleThreshold", "truncated"],
    followUp: {
      tool: TOOL_NAMES.readGetReviewSessionDetail,
      inputFields: ["activities[].reviewSessionId"],
      answerFields: ["session", "planJson", "intentJson", "stateSnapshots", "transitions", "requests"],
      reason: "Use for stored plan, state snapshot, transition, and execution detail for one review session."
    }
  };
}

export function reviewFunnelUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: ["local_review_lifecycle_counts_for_the_selected_account"],
    cannotAnswer: [
      "sui_wallet_transaction_history",
      "complete_wallet_history",
      "execution_success_rate_for_all_wallet_activity",
      "transaction_building",
      "signing_data_or_readiness",
      "profit_or_pnl"
    ],
    answerFields: ["summary"],
    diagnosticOnlyFields: ["dataScope", "accountSource", "lowSampleWarning", "lowSampleThreshold", "truncated"]
  };
}

export function prepareActionReviewUserAnswerUse(
  fields: { hasBlockingPreliminaryChecks?: boolean } = {}
): UserAnswerUse {
  const hasBlockingPreliminaryChecks = fields.hasBlockingPreliminaryChecks ?? false;
  return {
    canAnswer: [
      "internal_review_card_for_user_review",
      "preliminary_check_results_for_proposed_plan",
      "proposed_plan_asset_flow_preview",
      ...(hasBlockingPreliminaryChecks ? ["why_signing_is_currently_blocked_for_this_review"] : [])
    ],
    cannotAnswer: [
      "transaction_execution_guarantee",
      "transaction_building",
      "signing_data_or_readiness",
      "wallet_custody_or_authorization",
      "route_quality",
      "fiat_usd_cash_out",
      "profit_or_pnl"
    ],
    answerFields: [
      "reviewSessionId",
      "card",
      "plans",
      "plans[].title",
      "plans[].summary",
      "plans[].assetFlowPreview",
      "plans[].preliminaryChecks",
      "preliminaryChecks"
    ],
    conclusionRuleFields: ["plans[].preliminaryChecks", "preliminaryChecks"],
    diagnosticOnlyFields: ["plans[].adapterData", "plans[].createdAt", "plans[].id"],
    followUp: {
      tool: TOOL_NAMES.sessionGetReviewStatus,
      inputFields: ["reviewSessionId"],
      answerFields: ["pollingStatus", "statusCategory", "reviewState"],
      reason: "Use for current review readiness; the prepare response only describes the proposal and any blocking preliminary checks."
    }
  };
}

export function prepareExternalProposalReviewUserAnswerUse(): UserAnswerUse {
  return {
    canAnswer: [
      "internal_review_card_for_user_review",
      "external_proposal_summary_for_local_review",
      "proposal_asset_flow_preview",
      "proposal_recipient_or_target_fields",
      "missing_evidence_for_non_signable_review",
      "required_user_choices_for_non_signable_review",
      "unsupported_claims_for_non_signable_review",
      "why_signing_is_currently_blocked_for_this_review"
    ],
    cannotAnswer: [
      "transaction_execution_guarantee",
      "transaction_building",
      "signing_data_or_readiness",
      "wallet_custody_or_authorization",
      "route_quality",
      EXTERNAL_PROPOSAL_SETTLEMENT_TOKEN_SELECTION_UNSUPPORTED_CLAIM_ID,
      "fiat_usd_cash_out",
      "profit_or_pnl"
    ],
    answerFields: [
      "reviewSessionId",
      "card",
      "plans",
      "plans[].reviewModel.proposedAction",
      "plans[].reviewModel.assetFlow",
      "plans[].reviewModel.recipients",
      "plans[].reviewModel.targets",
      "plans[].reviewModel.evidenceUsed",
      "plans[].reviewModel.missingEvidence",
      "plans[].reviewModel.requiredUserChoices",
      "plans[].reviewModel.unsupportedClaims",
      "plans[].reviewModel.freshness",
      "plans[].reviewModel.blockingChecks",
      "plans[].reviewModel.nonSignableReason",
      "preliminaryChecks"
    ],
    conclusionRuleFields: [
      "plans[].reviewModel.unsupportedClaims",
      "plans[].reviewModel.nonSignableReason",
      "preliminaryChecks"
    ],
    diagnosticOnlyFields: [
      "plans[].adapterData",
      "plans[].createdAt",
      "plans[].id",
      "plans[].reviewModel.rejectedExecutableFields"
    ],
    followUp: {
      tool: TOOL_NAMES.sessionGetReviewStatus,
      inputFields: ["reviewSessionId"],
      answerFields: ["pollingStatus", "statusCategory", "reviewState"],
      reason:
        "Use for current review status after the user opens the internal card; the prepare response does not make the proposal signable."
    }
  };
}

export function reviewSessionDetailUserAnswerUse(options: {
  hasCurrentRequest: boolean; hasCurrentExecution: boolean; hasHistoricalExecution: boolean;
} = { hasCurrentRequest: false, hasCurrentExecution: false, hasHistoricalExecution: false }): UserAnswerUse {
  const hasExecution = options.hasCurrentExecution || options.hasHistoricalExecution;
  return {
    canAnswer: ["stored_local_review_session_plan_and_lifecycle_detail", "stored_review_state_snapshots", "stored_transaction_request_history",
      ...(hasExecution ? ["stored_review_chain_execution_result"] : [])],
    cannotAnswer: ["sui_wallet_transaction_history", "complete_wallet_history", "transaction_execution_guarantee", "absolute_safety_verdict",
      "route_quality", "wallet_custody_or_authorization", "transaction_building", "signing_data_or_readiness", "profit_or_pnl",
      ...(hasExecution ? [] : ["chain_execution_result_without_execution_field"])],
    answerFields: ["session", "planJson", "intentJson", "stateSnapshots", "transitions", "requests",
      ...(options.hasCurrentRequest ? ["request"] : []), ...(options.hasCurrentExecution ? ["request.execution"] : [])],
    diagnosticOnlyFields: ["dataScope", "accountSource", "lowSampleWarning", "lowSampleThreshold", "truncated", "requestCount"],
    followUp: { tool: TOOL_NAMES.sessionGetReviewStatus, inputFields: ["session.reviewSessionId"],
      answerFields: ["status", "pollingStatus", "reviewState"],
      reason: "Read the current DB review and request status. Stored history, including imported history, is not an active approval." }
  };
}
