import QRCode from "qrcode";
import { CONNECTION_CONFLICT_MESSAGE, CONNECTION_RECONCILIATION_MESSAGE } from "../../core/session/walletConnection.js";
import { t } from "../../../review-app/src/i18n/i18n.js";
import { workflowViewSchema, type WorkflowView } from "../../core/session/workflowView.js";
import type { CardSnapshot, CardWalletDisplay } from "../contracts.js";
import { section, accordion, element, row, monoShort, button, field, select, timeValue } from "../../../review-app/src/ui/ui.js";
import { walletCommandGuidance, type CardConfirmation, type CardDisplayRecovery, type CardRenderer, type CardViewContext } from "./lifecycle.js";
import "./workflow.css";

const connectionLabels: Record<NonNullable<WorkflowView["connection"]>["status"], string> = {
  awaiting_approval: "Approve the connection in your wallet", connected: "Wallet connected",
  rejected: "Connection declined", failed: "Wallet connection unavailable", expired: "Connection expired",
  stopped: "Connection request stopped", disconnected: "Wallet disconnected"
};

function connectionView(snapshot: CardSnapshot, act?: (input: Record<string, unknown>) => void, wallet?: CardWalletDisplay, context?: CardViewContext) {
  const data = workflowViewSchema.parse(snapshot.data);
  const node = element("div", "workflow-card"), facts = section();
  let disposed = false;
  let confirmation: { action: CardConfirmation; overview: Element[] } | undefined;
  // Local presentation is not command authority. Every panel switch lets the
  // frame apply its current guidance and lock to the newly visible controls.
  const showPanel = (next?: { action: CardConfirmation; node: HTMLElement }) => {
    if (disposed) return;
    const overview = confirmation?.overview ?? [...node.children];
    confirmation = next ? { action: next.action, overview } : undefined;
    node.replaceChildren(...(next ? [next.node] : overview));
    context?.onDisplayChange?.();
  };
  const connected = data.connections.filter((connection) => connection.status === "connected");
  const manageable = data.connections.filter((connection) => data.manageableConnectionIds.includes(connection.connectionId));
  // An admitted operation describes its own target. The unsubmitted overview
  // describes current connections; a result must not display another wallet
  // under the original operation's status.
  const displayedConnections = data.connection
    ? data.connection.accounts.length ? [data.connection] : [] : data.connections.filter((connection) =>
      connection.status === "connected" || data.manageableConnectionIds.includes(connection.connectionId));
  const distinguishTargets = displayedConnections.length > 1 || !!data.connectionConflict;
  const usable = data.connections.find((connection) => connection.connectionId === data.usableConnectionId);
  const pending = data.connections.some((connection) => connection.status === "awaiting_approval" || connection.pendingAction === "disconnect");
  const waitingElsewhere = !data.connection && data.connections.some((connection) => connection.status === "awaiting_approval");
  const action = (label: string, input: Record<string, unknown>) => {
    const bound = ["connect", "disconnect", "use_account"].includes(String(input.action))
      ? { ...input, walletRunId: data.walletAvailability.walletRunId } : input;
    const control = button(label, () => { if (!disposed) act?.(bound); }, ["disconnect"].includes(String(input.action)) ? "danger" : input.action === "connect" ? "primary" : "secondary");
    control.dataset.cardAction = String(input.action); control.disabled = !act; return control;
  };
  facts.append(row("Network", t.common.mainnet));
  if (data.runtimeRecovery) {
    const recovery = data.runtimeRecovery;
    const message = "phase" in recovery
      ? recovery.phase === "stopping" ? "Stopping the wallet connection service…" : data.walletAvailability.status !== "available" ? data.walletAvailability.message : "Confirming wallet service recovery…"
      : recovery.outcome === "available" ? "Wallet service restarted."
      : recovery.outcome === "superseded" ? "A newer wallet service restart replaced this request."
      : recovery.message ?? "This wallet service restart could not be confirmed.";
    const status = row("Wallet service", message); status.setAttribute("role", "status"); facts.append(status);
    facts.append(element("p", "ui-note", "Restarting the service does not approve a connection, revoke a connection in your wallet, or cancel a submitted transaction."));
    node.append(facts);
    return { node, dispose: () => { disposed = true; } };
  }
  const status = row(data.walletAvailability.status !== "available" ? "Last recorded status" : "Status",
    data.connectionAction === "disconnect" && data.connection?.status === "failed" ? "Disconnection could not be confirmed" :
    (data.connection ? data.connection.pendingAction === "disconnect" : pending && connected.some((item) => item.pendingAction === "disconnect")) ? "Disconnecting wallet…" : data.connection ? connectionLabels[data.connection.status] : data.connectionConflict ? "Multiple wallet connections need attention" : waitingElsewhere ? "Connection approval is pending in another card" : data.connectionReconciliationRequired ? "Wallet connection needs attention" : usable ? "Wallet connected" : data.walletAvailability.status !== "available" ? connected.length ? "Wallet connected" : "Connection not confirmed" : displayedConnections.length ? "No usable wallet connection" : "No wallet connected");
  status.setAttribute("role", "status"); facts.append(status);
  if (data.walletAvailability.status !== "available") {
    facts.append(element("p", "ui-note", data.walletAvailability.message));
    if (data.connection && !displayedConnections.length) {
      facts.append(row("Last updated", timeValue(data.connection.updatedAt)));
    }
  }
  if (data.connection?.reason) facts.append(element("p", "ui-note", data.connection.reason));
  if (data.activeAccount && connected.some((connection) => connection.accounts.some((account) => account !== data.activeAccount))) {
    facts.append(row("Saved default address", monoShort(data.activeAccount)));
  }
  if (data.connectionConflict) facts.append(element("p", "ui-note", CONNECTION_CONFLICT_MESSAGE));
  if (act && data.allowedActions.includes("connect") && snapshot.input.intent === "manage") facts.append(action("Connect wallet", { action: "connect" }));
  node.append(facts);
  const details = accordion("Details");
  if (data.walletObservation) details.body.append(row("Last service check", timeValue(data.walletObservation.observedAt)));
  if (data.connection && !distinguishTargets) details.body.append(row("Connection", data.connection.connectionId));

  const choices = usable?.accounts.map((account) => ({ connection: usable, account })) ?? [];
  const readAccount = data.assetReadAccount;
  if (act && data.allowedActions.includes("use_account") && choices.some((choice) => readAccount?.status !== "available" || choice.account !== readAccount.account)) {
    const accounts = section("Address for reads");
    accounts.append(element("p", "ui-note", "Choose the default address for reads. Existing transaction reviews keep their original address."));
    if (choices.length === 1) {
      const choice = choices[0]!;
      accounts.append(action("Use address", { action: "use_account", connectionId: choice.connection.connectionId, account: choice.account }));
    } else {
      const form = document.createElement("form"), choiceInput = select({ choices: [{ value: "", label: "Select an address" },
        ...choices.map((choice) => ({ value: choice.account, label: choice.account }))] });
      form.className = "ui-form"; choiceInput.required = true; choiceInput.setAttribute("aria-label", "Default address for reads");
      const use = button("Use address", () => undefined); use.type = "submit"; use.dataset.cardAction = "use_account";
      form.append(field("Address", choiceInput), use); form.addEventListener("submit", (event) => {
        event.preventDefault(); const choice = choices.find((item) => item.account === choiceInput.value);
        if (!disposed && choice) act?.({ action: "use_account", walletRunId: data.walletAvailability.walletRunId, connectionId: choice.connection.connectionId, account: choice.account });
      }); accounts.append(form);
    }
    facts.append(accounts);
  }
  for (const connection of displayedConnections) {
    const item = element("div");
    if (distinguishTargets) item.append(row("Connection", connection.connectionId));
    if (data.walletAvailability.status === "unavailable") item.append(row("Last updated", timeValue(connection.updatedAt)));
    details.body.append(row("Connection expires", timeValue(connection.expiresAt)));
    item.append(row("Wallet", connection.walletName ?? "Connected wallet"));
    if (!data.connection && connection.status !== "connected") {
      item.append(row("Recorded status", connectionLabels[connection.status]));
      if (connection.reason) item.append(element("p", "ui-note", connection.reason));
    }
    if (!data.connection && !data.connectionConflict && data.walletAvailability.status === "available" && !pending && connection.connectionId !== data.usableConnectionId) {
      item.append(element("p", "ui-note", "Recorded connection. It is not available for account use."));
    }
    for (const account of connection.accounts) item.append(row("Approved address", monoShort(account)));
    if (act && data.manageableConnectionIds.includes(connection.connectionId) && data.allowedActions.includes("disconnect")) {
      const controls = element("div", "card-actions");
      const open = button("Disconnect", () => undefined, "secondary"); open.dataset.cardAction = "disconnect"; open.disabled = !act;
      open.addEventListener("click", () => {
        if (disposed) return;
        const confirmation = section("Disconnect wallet?");
        confirmation.append(row("Wallet", connection.walletName ?? "Wallet"), row("Network", t.common.mainnet));
        if (distinguishTargets) confirmation.append(row("Connection", connection.connectionId));
        for (const account of connection.accounts) confirmation.append(row("Account", monoShort(account)));
        const back = button("Back", () => showPanel(), "secondary");
        const actions = element("div", "card-actions");
        actions.append(action("Confirm disconnect", { action: "disconnect", connectionId: connection.connectionId }), back);
        confirmation.append(actions);
        showPanel({ action: "disconnect", node: confirmation });
      });
      controls.append(open); item.append(controls);
      if (snapshot.input.intent === "disconnect" && manageable.length === 1) queueMicrotask(() => { if (!disposed) open.click(); });
    }
    facts.append(item);
  }
  let canvas: HTMLCanvasElement | undefined, scanInstruction: HTMLElement | undefined;
  if (data.connection?.status === "awaiting_approval" && data.walletAvailability.status === "available") {
    if (wallet && wallet.connectionId === data.connection.connectionId) {
      canvas = document.createElement("canvas"); canvas.className = "workflow-qr";
      canvas.hidden = true;
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "Wallet connection QR code");
      scanInstruction = element("p", "ui-note workflow-qr-instruction", "Scan to connect your Sui wallet.");
      scanInstruction.hidden = true;
      facts.append(scanInstruction, canvas);
    } else facts.append(element("p", "ui-note", "The QR code is not available in this view."));
  }
  if (act && data.allowedActions.includes("stop_connection")) facts.append(action("Stop connecting", { action: "stop_connection" }));
  if (details.body.children.length) facts.append(details.details);
  let drawing = false, displayFailure: CardDisplayRecovery | undefined;
  const draw = () => {
    if (disposed || drawing || !canvas || !wallet) return;
    drawing = true; displayFailure = undefined;
    canvas.hidden = true;
    if (scanInstruction) scanInstruction.hidden = true;
    // Report the asynchronous result to the frame. A state read does not by
    // itself mean this canvas was painted successfully.
    void QRCode.toCanvas(canvas, wallet.pairingUri).then(() => {
      if (disposed) return;
      drawing = false; canvas!.hidden = false;
      if (scanInstruction) scanInstruction.hidden = false;
      context?.onDisplayChange?.();
    }, () => {
      if (disposed) return;
      drawing = false;
      displayFailure = { message: "The QR code could not be displayed.", retry: draw };
      context?.onDisplayChange?.();
    });
  };
  return { node, mount: draw, displayRecovery: () => displayFailure, visibleConfirmation: () => confirmation?.action,
    dispose: () => { disposed = true; confirmation = undefined; } };
}

export const connectRenderer = {
  title: "Wallet connection",
  guidance(snapshot, context) {
    const command = walletCommandGuidance(context);
    if (command) return command;
    const parsed = workflowViewSchema.safeParse(snapshot?.data);
    if (!context.confirmed || !parsed.success) return context.recoveryNeeded ? "Ask in chat to check your wallet connection." : undefined;
    const data = parsed.data;
    if (data.connectionAction === "disconnect" && data.connection?.status === "failed") {
      return "Check the connection in your wallet app and remove it there if it is still listed. Disconnection was not confirmed here.";
    }
    // The visible heading, effects and Confirm/Back controls describe this
    // step. A route back into the overview would name controls hidden here.
    if (context.visibleConfirmation) return undefined;
    if (data.runtimeRecovery) return undefined;
    if (data.connectionAction === "disconnect" && data.connection?.status === "disconnected") {
      return data.connectionConflict
        ? "Ask in chat to open wallet connection controls to disconnect another saved connection."
        : data.connections.some((item) => item.status === "connected")
          ? "To manage the remaining connection, ask in chat to open wallet connection controls." : undefined;
    }
    if (data.walletAvailability.status === "unavailable") return t.common.walletStatusRecovery;
    if (data.connectionReconciliationRequired) return CONNECTION_RECONCILIATION_MESSAGE;
    if (data.connection?.pendingAction === "disconnect" || !data.connection && data.connections.some((item) => item.pendingAction === "disconnect")) return "If this disconnection is not responding, " +
      "ask in chat to open Settings, then use Troubleshooting to restart the connection service. Check any retained connection in your wallet app.";
    if (data.connectionConflict) return context.readOnly || !data.allowedActions.includes("disconnect")
      ? "Ask in chat to open wallet connection controls, then disconnect the connections you no longer need." : undefined;
    if (!data.connection && data.connections.some((connection) => connection.status === "awaiting_approval")) {
      return "Continue in the wallet connection card you opened first.";
    }
    if (data.connection?.status === "awaiting_approval") {
      return context.readOnly ? "You can ask in chat to check this connection request." : undefined;
    }
    if (data.manageableConnectionIds.length || data.connections.some((connection) => connection.status === "connected" || connection.pendingAction)) {
      return context.recoveryNeeded && context.readOnly ? "Ask in chat to check your wallet connection." : undefined;
    }
    if (data.automaticAction && !context.automaticPaused) return undefined;
    return data.allowedActions.includes("connect") && snapshot?.input.intent === "manage" && !context.readOnly
      ? undefined : "Ask in chat to connect your wallet.";
  },
  controls: (snapshot, act, _display, wallet = undefined, context = undefined) => connectionView(snapshot, act, wallet, context),
  result: (snapshot, _receipt, act, wallet = undefined, context = undefined) => connectionView(snapshot, act, wallet, context)
} satisfies CardRenderer;
