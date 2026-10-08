import { CONNECTION_CONFLICT_MESSAGE, CONNECTION_RECONCILIATION_MESSAGE } from "../../core/session/walletConnection.js";
import { workflowViewSchema, reviewWalletChoices, type WorkflowView } from "../../core/session/workflowView.js";
import { section, element, row, accordion, button, mono, monoShort, timeValue } from "../../../review-app/src/ui/ui.js";
import { rawToDisplay, signedRawToDisplay, suiAmount } from "../../../review-app/src/format.js";
import { gasRows } from "../../../review-app/src/ui/chainReceiptView.js";
import { receiptView } from "../../../review-app/src/ui/receiptView.js";
import { transactionGraph, createTransactionGraph, disposePtbGraphs } from "../../../review-app/src/ui/ptbDiagram.js";
import { receiptForCard } from "./receiptData.js";
import type { CardSnapshot, CardReceiptDisplay } from "../contracts.js";
import { walletCommandGuidance, type CardRenderer, type CardViewContext } from "./lifecycle.js";
import type { ProposalReviewModel } from "../../core/proposal/types.js";
import { t } from "../../../review-app/src/i18n/i18n.js";
import { REVIEW_UI_LABELS } from "../../core/action/types.js";
import "./workflow.css";

// Labels describe backend facts; they never grant an action or infer an outcome.
const reviewSessionLabels: Record<NonNullable<WorkflowView["review"]>["status"], string> = {
  ...REVIEW_UI_LABELS,
  proposed: "Review not prepared", awaiting_wallet: "Wallet connection needed",
  wallet_connected: "Review not prepared", expired: "Review expired"
};
const transactionRequestLabels: Record<NonNullable<WorkflowView["request"]>["requestStatus"], string> = {
  awaiting_signature: "Waiting for approval in your wallet", submitting: "Submitting transaction",
  awaiting_chain_result: "Waiting for transaction result", stopped: "Approval request stopped",
  request_failed: "Approval request ended", outcome_unknown: "Transaction result not confirmed", completed: "Transaction result confirmed"
};
type Review = NonNullable<WorkflowView["review"]>;

function proposalFacts(proposal: ProposalReviewModel, checks: NonNullable<Review["plan"]["preliminaryChecks"]>): HTMLElement {
  const node = section("External proposal — view only");
  node.append(element("p", undefined, proposal.proposedAction.title));
  const detail = accordion("Details");
  const sourceKinds: Record<ProposalReviewModel["proposalSource"]["kind"], string> = {
    mcp_server: "MCP server", ai_client: "AI client", user: "User", other: "Other"
  };
  const timingLabels: Record<ProposalReviewModel["freshness"]["status"], string> = {
    current: "Current at evaluation", expired: "Expired at evaluation",
    created_in_future: "Created after evaluation time", expiry_not_provided: "Expiry not provided"
  };
  node.append(element("p", "ui-note", proposal.nonSignableReason.message),
    row("Source", proposal.proposalSource.name), row("Source kind", sourceKinds[proposal.proposalSource.kind]),
    row("Action", proposal.proposedAction.kind === "payment" ? "Payment" : "Sui action"),
    row("Purpose", proposal.proposedAction.purpose), row("Declared network", proposal.proposedAction.network));
  for (const recipient of proposal.recipients) {
    const value = element("span");
    if (recipient.label) value.append(element("span", undefined, `${recipient.label}${recipient.address ? " · " : ""}`));
    if (recipient.address) value.append(mono(recipient.address));
    node.append(row("Proposed recipient", value));
  }
  for (const target of proposal.targets) {
    if (typeof target === "string") { node.append(row("Proposed target", target)); continue; }
    node.append(row("Proposed target", target.label ?? "Sui action target"));
    detail.body.append(element("h3", "ui-section-title", "Target details"));
    for (const [key, label] of [["packageId", "Package"], ["module", "Module"], ["function", "Function"], ["objectId", "Object"]] as const) {
      if (target[key]) detail.body.append(row(label, mono(target[key])));
    }

  }
  // Declared strings are displayed without token conversion, aggregation or
  // promotion to verified transaction amounts. This replaces generic preview rows.
  for (const [direction, label] of [["outgoing", "Proposed send"], ["expectedIncoming", "Proposed receive"], ["fees", "Proposed fee"]] as const) {
    for (const amount of proposal.assetFlow[direction]) {
      const item = element("div");
      item.append(row(label, `${amount.amountDisplay}${amount.symbol ? ` ${amount.symbol}` : ""}${amount.denomination ? ` (denomination: ${amount.denomination})` : ""}`));
      if (amount.coinType) {
        detail.body.append(row(`Declared asset · ${amount.symbol ?? amount.amountDisplay}`, mono(amount.coinType)));
      }
      node.append(item);
    }
  }
  node.append(row("Declared timing", timingLabels[proposal.freshness.status]), element("p", "ui-note", proposal.freshness.reason));
  for (const group of [proposal.missingEvidence, proposal.requiredUserChoices, proposal.unsupportedClaims]) {
    for (const item of group) node.append(row(item.label, item.reason));
  }
  if (proposal.proposalSource.reference) detail.body.append(row("Source reference", proposal.proposalSource.reference));
  detail.body.append(row("Proposal created", timeValue(proposal.freshness.proposalCreatedAt)),
    row("Proposal expires", proposal.freshness.proposalExpiresAt ? timeValue(proposal.freshness.proposalExpiresAt) : "Not provided"),
    row("Evaluated at", timeValue(proposal.freshness.evaluatedAt)));
  const evidence = element("div"); evidence.append(element("h3", "ui-section-title", "Proposal information"));
  for (const fact of proposal.evidenceUsed) evidence.append(row(fact.label, fact.summary));
  const passed = element("div"); passed.append(element("h3", "ui-section-title", "Passed proposal checks"));
  for (const check of checks.filter((item) => item.status === "pass")) passed.append(row(check.label, check.message));
  detail.body.append(evidence);
  if (passed.children.length > 1) detail.body.append(passed);
  node.append(detail.details);
  return node;
}

function displayedReviewAccount(data: WorkflowView): string | undefined {
  return data.review?.account ?? (data.assetReadAccount?.status === "available" ? data.assetReadAccount.account : undefined);
}

function reviewedConditions(data: WorkflowView): HTMLElement {
  const review = data.review!, human = review.state?.humanReadableReview, plan = review.plan;
  const node = section(human?.proposedAction.title ?? plan.title);

  const address = displayedReviewAccount(data);
  const receivesHere = human?.recipients.some((item) => item.role === "output_recipient" && item.address === address);
  node.append(row(review.account ? receivesHere ? "Send and receive account" : "Reviewed account" : "Account to review", address ? monoShort(address) : "Not selected"), row("Network", t.common.mainnet));
  if (human) {
    for (const amount of human.assetFlow.outgoing) node.append(row("You send, up to", `${rawToDisplay(amount.rawAmount, amount.decimals)} ${amount.symbol}`));
    for (const amount of human.assetFlow.expectedIncoming) node.append(row("Expected to receive", `${rawToDisplay(amount.rawAmount, amount.decimals)} ${amount.symbol}`));
    for (const amount of human.assetFlow.minimumIncoming) node.append(row("Minimum received on success", `${rawToDisplay(amount.rawAmount, amount.decimals)} ${amount.symbol}`));
    for (const amount of human.assetFlow.fees) node.append(row("Estimated trading fee", `${rawToDisplay(amount.rawAmount, amount.decimals)} ${amount.symbol}`));
    for (const recipient of human.recipients.filter((item) => item.address !== address)) node.append(row("Receiving account", mono(recipient.address)));
  } else {
    for (const amount of plan.assetFlowPreview.outgoing) node.append(row("Requested send", `${amount.amount} ${amount.symbol}`));
    for (const amount of plan.assetFlowPreview.expectedIncoming) node.append(amount.amountKind === "display_intent" && amount.amount === "unknown"
      ? row("Receive asset", `${amount.symbol} · amount not estimated yet`)
      : row("Proposed receive", `${amount.amount} ${amount.symbol}`));
  }
  const budget = review.state?.transactionReviewData?.gas.gasBudgetRaw;
  if (data.netGasMist !== undefined || budget !== undefined) node.append(row("Estimated network fee",
    `${data.netGasMist !== undefined ? suiAmount(data.netGasMist) : "Estimate unavailable"}${budget !== undefined ? ` · Network fee limit (gas budget): ${suiAmount(budget)}` : ""}`));
  return node;
}

function reviewDetails(review: Review, historical = false): HTMLElement {
  const node = section(), state = review.state, human = state?.humanReadableReview;
  node.append(row("Summary", human?.proposedAction.summary ?? review.plan.summary), row("Protocol", review.plan.protocol));
  if (human) node.append(row("Estimates checked at", timeValue(human.freshness.evaluatedAt)), row("Estimates expire", timeValue(human.freshness.expiresAt)));
  if (!state) { node.append(element("p", "ui-note", "This proposal has not been checked for a wallet account yet.")); return node; }
  if (state.evidenceValidity === "invalidated") node.append(element("p", "ui-note",
    "Details from the earlier, unsuccessful review. They are no longer current; the reason that review failed is kept below."));
  const gas = state.simulation?.gasCostSummary;
  if (gas) node.append(element("h3", "ui-section-title", "Estimated network fee breakdown"), element("p", "ui-note", t.receipt.estimatedNetFeeExplanation),
    ...gasRows({ computationMist: gas.computationCostRaw, storageMist: gas.storageCostRaw, storageRebateMist: gas.storageRebateRaw }));
  if (state.transactionReviewData?.gas.gasBudgetRaw !== undefined) node.append(element("p", "ui-note", t.receipt.gasLimitExplanation));
  const policy = state.transactionReviewData?.slippageOrMinOut;
  if (policy?.minOutRaw !== undefined) node.append(row("Minimum receive (raw units)", policy.minOutRaw));
  if (policy?.maxSlippageBps !== undefined) node.append(row("Maximum slippage (basis points)", String(policy.maxSlippageBps)));
  if (policy?.policySource) node.append(row("Slippage choice", policy.policySource === "user_explicit" ? "Chosen by you" : "Set by the protocol adapter's quote rules"));
  for (const change of state.simulation?.balanceChanges ?? []) {
    const amount = human && [...human.assetFlow.outgoing, ...human.assetFlow.expectedIncoming, ...human.assetFlow.fees].find((item) => item.coinType === change.coinType);
    node.append(row(`Estimated balance change · ${change.address}`, amount ? `${signedRawToDisplay(change.amount, amount.decimals)} ${amount.symbol}` : `${change.amount} raw units · ${change.coinType}`));
  }
  for (const change of state.simulation?.objectChanges ?? []) node.append(row(`Simulated object · ${change.objectId}`,
    `${change.inputState} → ${change.outputState} · ${change.idOperation}${change.objectType ? ` · ${change.objectType}` : ""}`));
  if (human) {
    const preparation = section("Notes from the initial review checks");
    preparation.append(element("p", "ui-note", "Recorded before the final checks. These notes describe that earlier step, not the transaction result."));
    for (const fact of human.evidenceUsed) preparation.append(row(fact.label, fact.summary));
    for (const gap of [...human.missingEvidence, ...human.unsupportedClaims, ...human.requiredUserChoices.filter((item) => item.id === "wallet_authorization_later")]) preparation.append(row(gap.label, gap.reason));
    node.append(preparation);
  }
  if (historical) for (const gap of (human?.requiredUserChoices ?? []).filter((item) => item.id !== "wallet_authorization_later")) node.append(row(gap.label, gap.reason));
  for (const check of state.checks.filter((item) => historical || item.status === "pass")) node.append(row(check.label, check.message));
  for (const source of state.transactionReviewData?.sourceReferences ?? []) node.append(row(source.source, timeValue(source.verifiedAt)));
  return node;
}

function pendingReviewDecision(snapshot: CardSnapshot, data: WorkflowView, act?: (input: Record<string, unknown>) => void, context?: CardViewContext, approvalVisible = true): HTMLDivElement {
  const review = data.review!, proposal = review.plan.reviewModel;
  const checks = review.state?.checks ?? review.plan.preliminaryChecks ?? [];
  const decision = element("div", "workflow-decision");
  const status = row("Status", review.preparing ? "Updating review…" : reviewSessionLabels[review.status]);
  if (!proposal) status.classList.add("review-status");
  status.setAttribute("role", "status"); decision.append(status);
  if (!proposal && data.walletAvailability.status !== "available") decision.append(element("p", "ui-note", data.walletAvailability.message));
  if (!proposal && data.connectionConflict) decision.append(element("p", "ui-note", CONNECTION_CONFLICT_MESSAGE));
  if (review.accountRequestPending) decision.append(element("p", "ui-note", "An earlier transaction request for this account is still being processed. This review can continue when that work finishes."));
  const feedback = element("div", "review-action-feedback");
  if (!proposal && act && data.mode === "review" && snapshot.state === "ready") {
    appendReviewActions(decision, feedback, data, act, context?.automaticPaused, approvalVisible);
  } else decision.append(feedback);
  if (review.error) feedback.append(element("p", "ui-note", review.error));
  for (const check of checks.filter((item) => item.status !== "pass")) {
    // This check is the backend's renewal prerequisite, not a failed
    // computation. The lifecycle displays its progress beside the button.
    if (!proposal && act && data.mode === "review" && snapshot.state === "ready" && review.state?.refreshReason === "review_evidence_stale" && check.id === "private_review_artifacts_refresh_required") continue;
    feedback.append(element("p", proposal && check.status === "fail" ? "ui-error" : "ui-note", `${check.label}: ${check.message}`));
  }
  for (const gap of (review.state?.humanReadableReview?.requiredUserChoices ?? []).filter((item) => item.id !== "wallet_authorization_later")) decision.append(row(gap.label, gap.reason));
  if (!review.plan.reviewModel && data.mode !== "review_manage") {
    if (context?.automaticPaused && snapshot.state === "ready") decision.append(element("p", "ui-note", "Automatic review updates are paused in this card."));
  }

  return decision;
}

// A live review owns its displayed material separately from the latest action
// projection. Renewal never turns retained display facts into current authority.
function liveReviewView(initial: CardSnapshot, initialData: WorkflowView, act: (input: Record<string, unknown>) => void, initialContext?: CardViewContext) {
  const node = element("div", "workflow-card"), graphSlot = element("div"), primary = section();
  const materialStatus = element("p", "ui-note review-material-status"), facts = element("div", "review-material-facts"), controls = element("div");
  const detail = accordion("Details");
  let snapshot = initial, data = initialData, context = initialContext, shown = initialData;
  let disposed = false, drawing = false, drawSerial = 0, detailsRendered = false;
  let graph: ReturnType<typeof createTransactionGraph> | undefined;
  const dispose = () => { if (!disposed) { disposed = true; drawSerial += 1; graph?.dispose(); } };
  try {
    const materialKey = (value: WorkflowView) => JSON.stringify(value.review?.state);
    let shownKey = materialKey(shown), pendingKey: string | undefined;
    const graphData = initialData.review!.state?.ptbVisualization?.mermaid;
    if (graphData) { graph = createTransactionGraph({ source: "review", mermaid: graphData }); graphSlot.append(graph.node); }
    else graphSlot.append(element("p", "ui-note", "The transaction graph appears when reviewed material is available."));
    const action = (input: Record<string, unknown>) => {
      if (disposed || !data.allowedActions.includes(input.action as WorkflowView["allowedActions"][number])) return;
      if (input.action === "request_signature" && (drawing || materialKey(data) !== shownKey || input.reviewRevision !== data.review!.reviewRevision)) return;
      act(input);
    };
    const renderDetails = () => {
      const body = reviewDetails(shown.review!);
      body.append(element("p", "ui-note", "To change the amount, assets or slippage, ask for a new review in chat."), element("p", "ui-note", data.boundary));
      detail.body.replaceChildren(body); detailsRendered = true;
    };
    const renderControls = () => {
      materialStatus.dataset.previous = String(drawing || data.review!.preparing || materialKey(data) !== shownKey || data.review!.status !== "ready_for_wallet_review");
      materialStatus.dataset.currentLabel = "Current estimates";
      materialStatus.dataset.previousLabel = shown.review!.state?.humanReadableReview ? "Previous estimates · not current" : "Amounts not checked yet";
      materialStatus.textContent = materialStatus.dataset.previous === "true" ? materialStatus.dataset.previousLabel : materialStatus.dataset.currentLabel;
      controls.replaceChildren(pendingReviewDecision(snapshot, data, action, context, !drawing));
    };
    facts.append(reviewedConditions(shown));
    primary.append(materialStatus, facts, controls); node.append(graphSlot, primary, detail.details);
    renderControls();
    detail.details.addEventListener("toggle", () => {
      if (disposed || detailsRendered || !detail.details.open || !detail.details.isConnected) return;
      try { renderDetails(); }
      catch { detail.body.replaceChildren(element("p", "ui-error", "These details could not be displayed. Close and reopen the details to try again.")); }
    });
    const commit = (next: WorkflowView, key: string, notify = false) => {
      shown = next; shownKey = key; drawing = false; pendingKey = undefined;
      facts.replaceChildren(reviewedConditions(shown));
      if (detail.details.open) renderDetails(); else { detail.body.replaceChildren(); detailsRendered = false; }
      renderControls(); if (notify) context?.onDisplayChange?.();
    };
    return { node, pending: () => drawing, update(next: CardSnapshot, nextContext: CardViewContext): boolean {
      const parsed = workflowViewSchema.parse(next.data), review = parsed.review;
      if (disposed || next.state !== "ready" || parsed.mode !== "review" || parsed.request || !review || review.plan.reviewModel ||
        review.reviewSessionId !== data.review!.reviewSessionId || review.plan.id !== data.review!.plan.id || review.account !== data.review!.account ||
        displayedReviewAccount(parsed) !== displayedReviewAccount(data)) return false;
      snapshot = next; data = parsed; context = nextContext;
      const key = materialKey(data);
      if (!review.preparing && review.status === "ready_for_wallet_review" && review.state?.humanReadableReview) {
        if ((key !== shownKey || drawing) && key !== pendingKey) {
          const serial = ++drawSerial;
          const mermaid = review.state.ptbVisualization?.mermaid;
          if (!mermaid) {
            graph?.dispose(); graph = undefined; graphSlot.replaceChildren(element("p", "ui-note", "The transaction graph is unavailable."));
            commit(data, key);
          } else {
            drawing = true; pendingKey = key;
            let completion;
            if (!graph) { graph = createTransactionGraph({ source: "review", mermaid }); graphSlot.replaceChildren(graph.node); completion = graph.ready; }
            else completion = graph.update(mermaid);
            void completion.then((outcome) => {
              if (disposed || serial !== drawSerial || outcome === "discarded") return;
              // The graph and facts commit together. A later stale projection may
              // keep them as explicitly historical facts, never as action input.
              commit(parsed, key, true);
            });
          }
        }
      }
      renderControls(); return true;
    }, dispose };
  } catch (error) { dispose(); throw error; }
}

function reviewView(snapshot: CardSnapshot, display?: CardReceiptDisplay, act?: (input: Record<string, unknown>) => void, context?: CardViewContext) {
  const data = workflowViewSchema.parse(snapshot.data), review = data.review;
  if (!review) throw new Error("Review data is unavailable.");
  if (act && snapshot.state === "ready" && data.mode === "review" && !data.request && !review.plan.reviewModel) return liveReviewView(snapshot, data, act, context);
  const node = element("div", "workflow-card");
  let disposed = false;
  const action = (input: Record<string, unknown>) => { if (!disposed) act?.(input); };
  const actionButton = (label: string, input: Record<string, unknown>, primary = false) => {
    const control = button(label, () => action(input), primary ? "primary" : "secondary");
    control.dataset.cardAction = String(input.action); control.disabled = !act; return control;
  };
  // A disclosure owns only its DOM. Opening it never calls a service or action.
  const details = (label: string, render: (body: HTMLElement) => void) => {
    const section = accordion(label); let rendered = false;
    section.details.addEventListener("toggle", () => {
      if (disposed || rendered || !section.details.open || !section.details.isConnected) return;
      try { render(section.body); rendered = true; }
      catch { disposePtbGraphs(section.body); section.body.replaceChildren(element("p", "ui-error", "These details could not be displayed. Close and reopen the details to try again.")); }
    });
    return section.details;
  };
  try {
    const request = data.request, execution = request?.execution;
    if (execution) {
      const historical = section("Reviewed conditions");
      historical.append(reviewedConditions(data), reviewDetails(review, true), element("p", "ui-note", data.boundary));
      if (data.receipt && typeof data.receipt === "object" && "status" in data.receipt && data.receipt.status === "found") {
        const rendered = receiptView(receiptForCard(snapshot, display), historical);
        return { ...rendered, dispose: () => { disposed = true; rendered.dispose(); } };
      } else {
        const facts = section(), receipt = execution.chainReceipt;
        const outcome = row("Result", execution.status === "success" ? "Transaction succeeded on Sui" : "Transaction failed on Sui");
        outcome.setAttribute("role", "status");
        facts.append(outcome, row("Sender", mono(receipt.sender)), row("Transaction hash", mono(request.transactionDigest)),
          row(t.common.retrievedAt, timeValue(receipt.source.fetchedAt)), element("p", "ui-note", "Additional amount and fee details are unavailable. The verified result is retained."));
        node.append(facts, details("Details", (body) => {
          for (const change of receipt.accountBalanceChanges) body.append(row(change.coinType, `${change.amountRaw} raw units`));
          for (const call of receipt.packageCalls) body.append(row("Package call", call.target));
          body.append(historical);
        }));
      }

    } else {
      const proposal = review.plan.reviewModel;
      const checks = review.state?.checks ?? review.plan.preliminaryChecks ?? [];
      if (!proposal) node.append(review.state?.ptbVisualization
        ? transactionGraph({ source: "review", mermaid: review.state.ptbVisualization.mermaid })
        : element("p", "ui-note", "The transaction graph appears when reviewed material is available."));
      const primary = proposal ? proposalFacts(proposal, checks) : reviewedConditions(data);
      let decision = element("div", "workflow-decision");
      const status = row("Status", request ? transactionRequestLabels[request.requestStatus] : review.preparing ? "Updating review…" : reviewSessionLabels[review.status]);
      if (!request && !proposal) status.classList.add("review-status");
      status.setAttribute("role", "status"); decision.append(status);
      if (!proposal && (!request || request.requestStatus === "awaiting_signature") && data.walletAvailability.status !== "available") decision.append(element("p", "ui-note", data.walletAvailability.message));
      if (request) {
        if (request.reason) decision.append(element("p", "ui-note", request.reason));
        if (["stopped", "request_failed"].includes(request.requestStatus)) decision.append(element("p", "ui-note", "No chain execution result has been confirmed."));
        if (data.observe && request.requestStatus === "outcome_unknown") decision.append(element("p", "ui-note", "Checking this transaction on Sui…"));
        if (act && data.allowedActions.includes("stop_waiting")) {
          decision.append(actionButton(request.requestStatus === "awaiting_signature" ? "Stop approval request" : "Stop checking result", { action: "stop_waiting" }));
          decision.append(element("p", "ui-note", request.requestStatus === "awaiting_signature"
            ? "This ends this approval request here. A late wallet approval will not be submitted."
            : "Stopping result checks does not cancel the transaction."));
        }
        if (act && !data.observe && data.allowedActions.includes("read_result")) decision.append(actionButton("Check transaction result", { action: "read_result" }));
        if (data.observationStopped) decision.append(element("p", "ui-note", "Automatic result checks are stopped. Checking this transaction cannot sign or resubmit it."));
      } else {
        decision = pendingReviewDecision(snapshot, data, act ? action : undefined, context);
      }
      primary.append(decision); node.append(primary);
      if (!proposal) node.append(details("Details", (body) => {
        if (request) body.append(row("Transaction hash", mono(request.transactionDigest)), row("Request updated", timeValue(request.updatedAt)));
        body.append(reviewDetails(review, !!request), element("p", "ui-note", "To change the amount, assets or slippage, ask for a new review in chat."), element("p", "ui-note", data.boundary));
      }));
    }
    return { node, dispose: () => { disposed = true; disposePtbGraphs(node); } };
  } catch (error) { disposed = true; disposePtbGraphs(node); throw error; }
}

function appendReviewActions(node: HTMLElement, feedback: HTMLElement, data: WorkflowView, act?: (input: Record<string, unknown>) => void, automaticPaused = false, approvalVisible = true): void {
  if (!act) return;
  const review = data.review!;
  const slot = element("div", "review-primary-slot");
  const actions = element("div", "review-action-row");
  const cancel = button("Cancel", () => act({ action: "cancel" }), "danger");
  cancel.setAttribute("aria-label", "Cancel review");
  cancel.dataset.cardAction = "cancel"; cancel.disabled = !data.allowedActions.includes("cancel");
  actions.append(slot, cancel);
  const shownWallets = new Set<string>();
  const choose = (action: "prepare_review" | "request_signature", label: string, account: string, choices: WorkflowView["connections"], primary: boolean) => {
    const send = (connectionId: string) => act?.({ action, connectionId, account, walletRunId: data.walletAvailability.walletRunId, reviewRevision: review.reviewRevision });
    const control = button(label, () => { if (choices.length === 1) send(choices[0]!.connectionId); }, primary ? "primary" : "secondary");
    control.dataset.cardAction = action; control.disabled = !act;
    control.classList.add("review-primary-action");
    if (choices.length === 1) {
      // The displayed target and this explicit click form the selection. No action
      // runs merely because this is the only candidate or the frame was recreated.
      if (!shownWallets.has(choices[0]!.connectionId)) {
        node.append(row("Wallet", choices[0]!.walletName ?? "Connected wallet")); shownWallets.add(choices[0]!.connectionId);
      }
      slot.append(control); node.append(actions);
      return;
    }
  };
  const canRequestApproval = !data.connectionConflict && approvalVisible && data.allowedActions.includes("request_signature") && !!review.account && data.walletAvailability.status === "available";
  const preparationAccount = data.assetReadAccount?.status === "available" ? data.assetReadAccount.account : undefined;
  const canPrepare = data.allowedActions.includes("prepare_review") && !!preparationAccount && data.walletAvailability.status === "available";
  const approvalChoices = canRequestApproval ? reviewWalletChoices(data, review.account!, true) : [];
  const preparationChoices = canPrepare ? reviewWalletChoices(data, preparationAccount!) : [];
  const automatic = data.automaticAction;
  if (!automaticPaused && !approvalChoices.length && automatic?.action === "prepare_review") {
    const target = preparationChoices.find((item) => item.connectionId === automatic.connectionId);
    if (target) { node.append(row("Wallet", target.walletName ?? "Connected wallet")); shownWallets.add(target.connectionId); }
  }
  if (canRequestApproval && canPrepare && review.account === preparationAccount && !approvalChoices.length && !preparationChoices.length) {
    node.append(element("p", "ui-note", "No wallet connection is available for this account."));
  } else {
    if (canRequestApproval && !approvalChoices.length) node.append(element("p", "ui-note", "No connected wallet is available for this transaction."));
    if (canPrepare && !preparationChoices.length) node.append(element("p", "ui-note", "No wallet connection is available to update the review for the selected account."));
  }
  if (approvalChoices.length) choose("request_signature", "Request wallet approval", review.account!, approvalChoices, true);
  else if (approvalVisible && preparationChoices.length && (!data.automaticAction || automaticPaused)) {
    choose("prepare_review", automaticPaused ? "Continue review" : review.state || review.error ? "Retry review" : "Update review", preparationAccount!, preparationChoices, true);
  }
  else {
    const wallet = reviewWalletChoices(data, review.account ?? preparationAccount ?? "");
    if (wallet.length === 1 && !shownWallets.has(wallet[0]!.connectionId)) {
      node.append(row("Wallet", wallet[0]!.walletName ?? "Connected wallet")); shownWallets.add(wallet[0]!.connectionId);
    }
    const unavailable = button("Request wallet approval", () => {}, "primary");
    unavailable.classList.add("review-primary-action"); unavailable.disabled = true;
    if (!data.connectionConflict) slot.append(unavailable); node.append(actions);
  }
  // One primary action occupies this position; its feedback stays below it.
  const lifetime = element("div", "review-lifetime");
  const remaining = element("span", "review-time-remaining", "Review time remaining");
  remaining.setAttribute("role", "timer");
  lifetime.append(remaining); node.append(lifetime, feedback);

}

export const reviewRenderer = {
  title: "Review transaction",
  guidance(snapshot, context) {
    const command = walletCommandGuidance(context);
    if (command) return command;
    const parsed = workflowViewSchema.safeParse(snapshot?.data);
    if (context.approvalUnresolved) return "Ask in chat to check the status of this same transaction request.";
    if (!context.confirmed || !parsed.success) return context.recoveryNeeded
      ? "Ask in chat to check this review's status before starting another review." : undefined;
    const data = parsed.data, review = data.review;
    if (!data.request && !snapshot?.input.attemptId && review && !review.plan.reviewModel &&
        (review.status === "expired" || snapshot?.state === "closed" && snapshot.reason !== "completed")) {
      return "Ask in chat for a new transaction review.";
    }
    if (data.request || snapshot?.input.attemptId) return context.recoveryNeeded
      ? "Ask in chat to check the status of this same transaction request." : undefined;
    if (!review || review.plan.reviewModel) return undefined;
    if (data.walletAvailability.status === "unavailable") return t.common.walletStatusRecovery;
    if (data.connectionReconciliationRequired) return CONNECTION_RECONCILIATION_MESSAGE;
    if (data.connectionConflict) return "Ask in chat to open wallet connection controls, then disconnect the connections you no longer need.";
    if (!data.usableConnectionId && data.manageableConnectionIds.length) return "A recorded wallet connection cannot be used for this review. Ask in chat to open wallet connection controls and disconnect the retained connection before connecting again.";
    if (context.readOnly) return "Ask in chat for a new transaction review.";
    if (review.error && data.mode === "review" && snapshot?.state === "ready" &&
        !data.allowedActions.includes("prepare_review") && !review.preparing) {
      return "You can check or change your selected account in the wallet connection card. Ask in chat to open it.";
    }
    return context.recoveryNeeded && !data.allowedActions.length ? "Ask in chat to check this review's status." : undefined;
  },
  titleFor: (snapshot) => {
    const view = workflowViewSchema.safeParse(snapshot.data);
    return view.success && view.data.request?.execution ? "Transaction result" : "Review transaction";
  },
  controls: (snapshot, act, display, _wallet = undefined, context = undefined) => reviewView(snapshot, display, act, context),
  result: (snapshot, display, act, _wallet = undefined, context = undefined) => reviewView(snapshot, display, act, context)
} satisfies CardRenderer;
