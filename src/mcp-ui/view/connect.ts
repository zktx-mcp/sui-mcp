import QRCode from "qrcode";
import { workflowViewSchema, closedWalletCardSchema, connectViewSchema, disconnectViewSchema } from "../../core/session/workflowView.js";
import { WALLET_CHAIN_LABELS, type WalletChainId } from "../../core/session/chainAccounts.js";
import { element, section, row, button, monoShort, timeValue, accordion } from "../../../review-app/src/ui/ui.js";
import type { CardSnapshot, CardWalletDisplay, CardReceiptDisplay } from "../contracts.js";
import { walletCommandGuidance, type CardRenderer, type CardContent, type CardViewContext, type CardGuidanceContext, type CardDisplayRecovery } from "./lifecycle.js";
import "./workflow.css";

function completed(snapshot: CardSnapshot) {
  const data = closedWalletCardSchema.parse(snapshot.data);
  const node = section();
  const status = row("Result", data.result.message); status.setAttribute("role", "status"); node.append(status);
  if (data.walletName) node.append(row("Wallet", data.walletName));
  for (const network of data.networks) node.append(row(WALLET_CHAIN_LABELS[network.chainId as WalletChainId] ?? network.chainId,
    network.status === "bound" ? "Approved" : network.status === "not_approved" ? "Not approved" : network.status === "multiple_accounts" ? "Several addresses returned" : "Invalid response"));
  node.append(row("Recorded at", timeValue(data.result.recordedAt)));
  if (data.result.pendingWork) node.append(element("p", "ui-note", data.result.pendingWork === "approval_response"
    ? "The original wallet response was still outstanding when this result was recorded. A late approval will not be used. Ask in chat to check current status if needed."
    : data.result.pendingWork === "session_removal" ? "An unaccepted wallet session required removal when this result was recorded. Ask in chat to check its current status."
      : "The wallet session's removal was not confirmed when this result was recorded. Ask in chat to check its current status."));
  node.append(element("p", "ui-note", "This card has ended. Ask in chat for another wallet request."));
  return { node, dispose: () => {} };
}

function active(snapshot: CardSnapshot, act?: (input: Record<string, unknown>) => void,
  wallet?: CardWalletDisplay, context?: CardViewContext) {
  const data = snapshot.kind === "disconnect" ? disconnectViewSchema.parse(snapshot.data) : connectViewSchema.parse(snapshot.data), node = section();
  const operationId = String(snapshot.input.operationId);
  const action = (label: string, input: Record<string, unknown>, danger = false) => {
    const control = button(label, () => { if (!disposed && act) act(input); }, danger ? "danger" : "primary");
    control.dataset.cardAction = String(input.action); control.disabled = !act; return control;
  };
  let disposed = false, mounted = false, drawing = false, failure: CardDisplayRecovery | undefined;
  const canvas = element("canvas", "workflow-qr"); canvas.hidden = true;
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Wallet connection QR code");
  const hint = element("p", "ui-note", "Scan to connect your wallet."); hint.hidden = true;
  const draw = () => {
    if (!mounted || disposed || drawing || !wallet) return;
    drawing = true; failure = undefined;
    void QRCode.toCanvas(canvas, wallet.pairingUri).then(() => {
      drawing = false; if (disposed) { canvas.width = 0; canvas.height = 0; return; } canvas.hidden = false; hint.hidden = false; context?.onDisplayChange?.();
    }, () => {
      drawing = false; if (disposed) return;
      failure = { message: "The QR code could not be displayed.", retry: draw }; context?.onDisplayChange?.();
    });
  };
  if (data.kind === "disconnect") {
    const target = data.connection?.connectionId === snapshot.input.connectionId ? data.connection : undefined;
    if (target) {
      node.append(row("Wallet", target.walletName ?? "Connected wallet"), row("Networks", target.requestedChains.map((id) => WALLET_CHAIN_LABELS[id]).join(", ")));
      if (data.allowedActions.includes("disconnect") && target.disconnectImpact) {
        for (const network of target.chainResults) if (network.status === "bound") node.append(row(WALLET_CHAIN_LABELS[network.chainId], monoShort(network.address)));
        node.append(row("Wallet approval requests to stop", String(target.disconnectImpact.requestCount)),
          element("p", "ui-note", "This removes this connection from use on every listed network. Saved records remain. Submitted transactions cannot be cancelled."),
          action("Confirm disconnect", { action: "disconnect", operationId, connectionId: target.connectionId,
            impactId: target.disconnectImpact.impactId, walletRunId: data.walletAvailability.walletRunId }, true));
      }
    }
    if (data.operation?.status === "running") node.append(row("Status", "Disconnecting…"));
    else if (!target) node.append(element("p", "ui-note", "The wallet session for this request is no longer current. Ask in chat for a new request."));
  } else {
    node.append(row("Requested networks", data.requestedChains.map((id) => WALLET_CHAIN_LABELS[id]).join(", ")));
    if (data.operation?.status === "running") {
      node.append(element("p", "ui-note", "Waiting for approval in your wallet."));
      if (wallet) node.append(hint, canvas);
      else node.append(element("p", "ui-note", "The QR code is unavailable in this view. Check this request's status."));
    } else if (data.allowedActions.includes("connect") && !data.automaticAction) node.append(action("Connect wallet", {
      action: "connect", operationId, chains: data.requestedChains, walletRunId: data.walletAvailability.walletRunId }));
    if (data.allowedActions.includes("stop_connection")) node.append(action("Stop connecting", { action: "stop_connection", operationId }));
  }
  if (data.allowedActions.includes("cancel")) node.append(action("Cancel", { action: "cancel" }, true));
  const details = accordion("Details"); details.body.append(row("Request ID", snapshot.cardId)); node.append(details.details);
  if (data.nextStep.message) node.append(element("p", "ui-note", data.nextStep.message));
  const presentation = (value: CardSnapshot) => {
    const { actionRemainingMs: _remaining, nextStateReadAfterMs: _next, walletObservation: _observation, ...facts } = workflowViewSchema.parse(value.data);
    return JSON.stringify({ state: value.state, input: value.input, facts });
  };
  return { node, update: (next: CardSnapshot, nextContext: CardViewContext) => {
      if (disposed || next.state === "closed" || presentation(next) !== presentation(snapshot) ||
          wallet?.pairingUri !== nextContext.wallet?.pairingUri || wallet?.connectionId !== nextContext.wallet?.connectionId) return false;
      context = nextContext; return true;
    },
    visibleConfirmation: () => data.kind === "disconnect" && snapshot.state === "ready" && data.allowedActions.includes("disconnect") && !disposed ? "disconnect" as const : undefined,
    mount: () => { mounted = true; draw(); }, displayRecovery: () => failure,
    dispose: () => { disposed = true; canvas.width = 0; canvas.height = 0; } };
}

export function walletCardRenderer(kind: "connect" | "disconnect") {
  const view = (snapshot: CardSnapshot, act?: (input: Record<string, unknown>) => void, wallet?: CardWalletDisplay, context?: CardViewContext): CardContent =>
    snapshot.state === "closed" ? completed(snapshot) : active(snapshot, act, wallet, context);
  return { title: kind === "connect" ? "Connect wallet" : "Disconnect wallet",
    guidance: (snapshot: CardSnapshot | undefined, context: CardGuidanceContext) => {
      if (snapshot?.state === "closed") return "Ask in chat for a new wallet request.";
      const command = walletCommandGuidance(context);
      if (command) return command;
      const data = workflowViewSchema.safeParse(snapshot?.data);
      if (context.confirmed && data.success) return data.data.nextStep.message;
      return undefined;
    },
    controls: (snapshot: CardSnapshot, act: (input: Record<string, unknown>) => void, _display?: CardReceiptDisplay, wallet?: CardWalletDisplay, context?: CardViewContext) => view(snapshot, act, wallet, context),
    result: (snapshot: CardSnapshot, _display?: CardReceiptDisplay, act?: (input: Record<string, unknown>) => void, wallet?: CardWalletDisplay, context?: CardViewContext) => view(snapshot, act, wallet, context) } satisfies CardRenderer;
}
export const connectRenderer = walletCardRenderer("connect");
