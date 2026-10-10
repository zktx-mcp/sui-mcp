import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { button } from "../../../review-app/src/ui/ui.js";
import { automaticWorkflowActionSchema, workflowActionSchema, workflowViewSchema, reviewWalletChoices } from "../../core/session/workflowView.js";
import { settingsViewSchema, type SettingsDraft } from "../../core/session/settingsOperation.js";
import { settingsUploadMessageBudget } from "../../core/session/settingsFileProtocol.js";
import { CARD_METADATA_KEY, CARD_DISPLAY_METADATA_KEY, WALLET_DISPLAY_METADATA_KEY, SETTINGS_FILE_METADATA_KEY, settingsFileDisplaySchema, type SettingsFileDisplay, CARD_RESOURCE_PREFIX, CARD_TOOLS,
  cardReferenceSchema, cardSnapshotSchema, cardReceiptDisplaySchema, cardWalletDisplaySchema, cardInputRequiredSchema,
  type CardKind, type CardReference, type CardSnapshot, type CardReceiptDisplay, type CardWalletDisplay } from "../contracts.js";
import "../../../review-app/public/ui.css";
import "./style.css";

declare const __SUI_MCP_VERSION__: string;
export type CardDisplayRecovery = { message: string; retry: () => void };
export type CardConfirmation = "disconnect";
export type CardContent = {
  node: HTMLElement; mount?: () => void; dispose?: () => void;
  update?: (snapshot: CardSnapshot, context: CardViewContext) => boolean;
  pending?: () => boolean;
  selectionHint?: string;
  displayRecovery?: () => CardDisplayRecovery | undefined;
  visibleConfirmation?: () => CardConfirmation | undefined;
};
export type SettingsViewTransport = {
  act(input: Record<string, unknown>, fileTransfer?: boolean): Promise<CardSnapshot>;
  readCurrent(): Promise<{ snapshot: CardSnapshot; requestStartedAt: number }>;
  uploadChunkLimit(operationId: string, fileId: string): number;
  setFileTransferActive(active: boolean): void;
  readFile(input: { operationId: string; fileId: string; offset: number; attemptId?: string | undefined }): Promise<SettingsFileDisplay>;
  download(filename: string, base64: string, attemptId?: string): Promise<{ isError?: boolean | undefined }>;
};
type NonImportSettingsDraft = SettingsDraft & { kind: Exclude<SettingsDraft["kind"], "import_local_data"> };
export type SettingsCommandProgress =
  | { kind: "preparation_response"; cardId: string; operationId: string; draft: NonImportSettingsDraft }
  | { kind: "backup_check_response"; cardId: string; operationId: string; fileId: string; action: "settings_prepare" | "settings_seal_upload" };
export type CardViewContext = { automaticPaused: boolean; onDisplayChange?: () => void; settings?: SettingsViewTransport | undefined;
  settingsCommandProgress?: SettingsCommandProgress | undefined };
export type CardGuidanceContext = {
  confirmed: boolean; readOnly: boolean; recoveryNeeded: boolean;
  approvalUnresolved: boolean; automaticPaused: boolean;
  commandPending?: { phase: "confirming" | "sending"; action: string } | undefined;
  visibleConfirmation?: CardConfirmation | undefined;
};
export function walletCommandGuidance(context: CardGuidanceContext): string | undefined {
  const pending = context.commandPending;
  if (!pending) return undefined;
  if (pending.phase === "confirming") return "Checking the current selection…";
  if (pending.action === "request_signature") return "Waiting for a response… Ask in chat to check the status of this same transaction request. Do not request approval again while its outcome is unknown.";
  return "Waiting for a response… You can ask in chat to check this same request.";
}
export type CardRenderer = {
  title: string;
  titleFor?: (snapshot: CardSnapshot) => string;
  guidance?: (snapshot: CardSnapshot | undefined, context: CardGuidanceContext) => string | undefined;
  controls(snapshot: CardSnapshot, submit: (input: Record<string, unknown>) => void, display?: CardReceiptDisplay, wallet?: CardWalletDisplay, context?: CardViewContext): HTMLElement | CardContent;
  result(snapshot: CardSnapshot, display?: CardReceiptDisplay, act?: (input: Record<string, unknown>) => void, wallet?: CardWalletDisplay, context?: CardViewContext): CardContent;
};
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function isNonImportSettingsDraft(draft: SettingsDraft): draft is NonImportSettingsDraft {
  return draft.kind !== "import_local_data";
}
// View-only communication facts; backend preparation and permission stay separate.
function settingsCommandProgress(basis: CardSnapshot, current: CardSnapshot, input: Record<string, unknown>): SettingsCommandProgress | undefined {
  if (basis.kind !== "settings" || current.kind !== "settings" || basis.cardId !== current.cardId || current.state !== "ready") return undefined;
  const before = settingsViewSchema.safeParse(basis.data), after = settingsViewSchema.safeParse(current.data);
  if (!before.success || !after.success) return undefined;
  const prior = before.data, next = after.data;
  const draft = next.draft;
  if (!draft || !prior.draft || prior.operationId !== next.operationId || input.operationId !== next.operationId ||
      JSON.stringify(prior.draft) !== JSON.stringify(draft)) return undefined;
  if (isNonImportSettingsDraft(draft)) {
    return input.action === "settings_prepare" ? { kind: "preparation_response", cardId: current.cardId,
      operationId: next.operationId, draft } : undefined;
  }
  const fileId = next.file?.fileId;
  if (!fileId || !prior.file?.fileId || prior.file.fileId !== fileId ||
      input.action !== "settings_prepare" && input.action !== "settings_seal_upload" ||
      input.action === "settings_seal_upload" && input.fileId !== fileId) return undefined;
  return { kind: "backup_check_response", cardId: current.cardId, operationId: next.operationId, fileId, action: input.action };
}
function unwrap(result: unknown, host: string | undefined): Record<string, unknown> {
  const record = object(result);
  if (!record) throw new Error("The app did not provide a usable card response.");
  if (record.structuredContent !== undefined) return record;
  if (Array.isArray(record.content)) for (const entry of record.content) {
    const text = object(entry);
    if (text?.type !== "text" || typeof text.text !== "string") continue;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = object(JSON.parse(text.text)); } catch { continue; }
    if (parsed?.ok !== undefined) return { ...record, structuredContent: parsed };
    // The qualified Codex host wraps the MCP result in a JSON text block.
    if (host === "chatgpt" && parsed && Array.isArray(parsed.content)) return unwrap(parsed, undefined);
  }
  return record;
}
function matchingDisplay(snapshot: CardSnapshot | undefined, display: CardReceiptDisplay): boolean {
  const request = object(object(snapshot?.data)?.request);
  return !!snapshot && (snapshot.kind === "receipt" || snapshot.kind === "review") && display.cardId === snapshot.cardId &&
    display.revision === snapshot.revision &&
    display.transactionDigest === (snapshot.kind === "receipt" ? snapshot.input.digest : request?.transactionDigest) &&
    (snapshot.kind !== "review" || display.attemptId === request?.attemptId);
}
function linkedCardId(result: Record<string, unknown>, host: string | undefined): string | undefined {
  let id: string | undefined;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const link = object(item);
    let uri: string | undefined;
    if (link?.type === "resource_link" && typeof link.uri === "string" && link.uri.startsWith(CARD_RESOURCE_PREFIX)) uri = link.uri;
    if (host === "Claude" && link?.type === "text" && typeof link.text === "string") {
      const match = /^\[Resource link: card_([A-Za-z0-9_-]+)\] (suimcp:\/\/cards\/([A-Za-z0-9_-]+)) \(Saved data for this exact card\.\)$/.exec(link.text);
      if (match) {
        if (match[1] !== match[3]) throw new Error("The saved card links could not be matched to one card.");
        uri = match[2];
      }
    }
    if (uri === undefined) continue;
    const candidate = uri.slice(CARD_RESOURCE_PREFIX.length);
    if (!candidate || encodeURIComponent(candidate) !== candidate || (id !== undefined && candidate !== id) ||
        (link?.type === "resource_link" && typeof link.name === "string" && link.name.startsWith("card_") && link.name !== `card_${candidate}`)) {
      throw new Error("The saved card links could not be matched to one card.");
    }
    id = candidate;
  }
  return id;
}
function responseParts(result: Record<string, unknown>) {
  const payload = object(result.structuredContent);
  const inputRequired = payload?.ok === true ? cardInputRequiredSchema.safeParse(payload.data) : undefined;
  const error = object(object(payload?.error)?.details);
  const value = inputRequired?.success ? undefined : payload?.ok === true ? object(payload.data)?.card ?? payload.data : error?.snapshot;
  const snapshot = value === undefined ? undefined : cardSnapshotSchema.parse(value);
  if (snapshot?.kind === "settings") settingsViewSchema.parse(snapshot.data);
  const privateValue = object(result._meta)?.[CARD_DISPLAY_METADATA_KEY];
  const display = privateValue === undefined ? undefined : cardReceiptDisplaySchema.parse(privateValue);
  if (display && !matchingDisplay(snapshot, display)) {
    throw new Error("Transaction details do not match this saved result.");
  }
  const walletValue = object(result._meta)?.[WALLET_DISPLAY_METADATA_KEY];
  const wallet = walletValue === undefined ? undefined : cardWalletDisplaySchema.parse(walletValue);
  if (wallet && (!snapshot || snapshot.kind !== "connect" || wallet.cardId !== snapshot.cardId || wallet.revision !== snapshot.revision ||
      wallet.connectionId !== object(object(snapshot.data)?.connection)?.connectionId)) throw new Error("The connection QR code does not match this card.");
  return { snapshot, display, wallet, inputRequired: inputRequired?.success ? inputRequired.data : undefined,
    error: typeof error?.message === "string" ? error.message : typeof error?.reason === "string" ? error.reason : undefined };
}

export function startCard(kind: CardKind, renderer: CardRenderer): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Card root is unavailable.");
  const heading = document.createElement("h1"); heading.textContent = renderer.title;
  const status = document.createElement("p"); status.className = "ui-note"; status.setAttribute("role", "status");
  const issue = document.createElement("p"); issue.className = "ui-error"; issue.setAttribute("role", "alert");
  const notice = document.createElement("p"); notice.className = "ui-note card-guidance";
  const content = document.createElement("section");
  const actions = document.createElement("div"); actions.className = "card-actions";
  const progressHint = document.createElement("div"); progressHint.className = "card-progress-hint"; progressHint.hidden = true;
  root.replaceChildren(heading, status, issue, content, notice, progressHint, actions);
  const app = new App({ name: "sui-mcp-card", version: __SUI_MCP_VERSION__ }, {}, { autoResize: true, strict: true });
  const lifetime = new AbortController();
  const business = kind === "connect" || kind === "review";
  const settings = kind === "settings", interactive = business || settings;
  let settingsFileTransfer = false;

  type Confirmation = { status: "unconfirmed" | "confirmed" } |
    { status: "needed"; afterRead: number; automatic: boolean } |
    { status: "read_failed" | "rejected"; message: string };
  type ReadOutcome = { kind: "accepted"; snapshot: CardSnapshot; id: number; requestStartedAt: number } |
    { kind: "ignored" | "failed" | "disposed"; id: number };
  type ReadFlight = { id: number; promise: Promise<ReadOutcome> };
  type CommandFlight = { input: Record<string, unknown>; basis: CardSnapshot; phase: "confirming" | "sending" };
  type Disposition = "active" | "observed" | "past";
  type FailedCommand = { input: Record<string, unknown>; basis: CardSnapshot; message: string; delivery: "unknown" | "rejected"; data?: unknown;
    disposition: Disposition; retryRequired: boolean };

  let reference: CardReference | undefined, cardId: string | undefined;
  let boundInput: CardSnapshot["input"] | undefined;
  let snapshot: CardSnapshot | undefined, display: CardReceiptDisplay | undefined, creatingDisplay: CardReceiptDisplay | undefined;
  let walletDisplay: CardWalletDisplay | undefined;
  let connected = false, initialized = false;
  let creating: unknown, inputRequest: string | undefined;
  let confirmation: Confirmation = { status: "unconfirmed" };
  let openingError: string | undefined, displayError: string | undefined, selectionNotice: string | undefined;
  let failedCommand: FailedCommand | undefined, commandFlight: CommandFlight | undefined;
  let automation: "continue" | "paused" = "continue";
  let reading: ReadFlight | undefined, readRequested: "background" | "explicit" | undefined;
  let readSerial = 0, observedAt = 0;
  let reviewEndsAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let recovery: HTMLButtonElement | undefined;
  let displayedView: CardContent | undefined, renderedKey: string | undefined, attemptedKey: string | undefined;
  let displayedInput = false;

  // A command's delivery is distinct from its result and present relevance.
  // These predicates consume stored facts; they never write workflow state.
  function classifyFailedCommand(): Disposition | undefined {
    if (!failedCommand || !snapshot) return undefined;
    const { input, basis } = failedCommand, data = object(snapshot.data), prior = object(basis.data);
    const request = object(data?.request), review = object(data?.review), connection = object(data?.connection);
    const oldRequest = object(prior?.request), oldConnection = object(prior?.connection);
    const sameRequest = !!request && request.attemptId === oldRequest?.attemptId;
    const sameConnection = !!connection && connection.connectionId === oldConnection?.connectionId;
    if (!business) return snapshot.state === "running" || snapshot.reason === "completed" ? failedCommand.delivery === "rejected" ? "past" : "observed" :
      snapshot.state === "closed" ? "past" : "active";
    if (input.walletRunId && input.walletRunId !== object(data?.walletAvailability)?.walletRunId && input.walletRunId !== data?.acceptedWalletRunId) return "past";
    switch (input.action) {
      case "connect":
        if (snapshot.state !== "ready" && connection) return "observed";
        if (data?.walletAvailability && object(data.walletAvailability)?.status === "available" &&
            Array.isArray(data.connections) && data.connections.some((item) => object(item)?.status === "connected")) return "past";
        break;
      case "prepare_review":
        if (typeof review?.reviewRevision === "number" && typeof input.reviewRevision === "number" && review.reviewRevision > input.reviewRevision) {
          return review.account === input.account ? "observed" : "past";
        }
        break;
      case "request_signature":
        if (request?.account === input.account && request?.reviewRevision === input.reviewRevision) return "observed";
        if (typeof review?.reviewRevision === "number" && typeof input.reviewRevision === "number" && review.reviewRevision > input.reviewRevision) return "past";
        if (!request && review && review.reviewRevision === input.reviewRevision && review.account === input.account &&
            review.status === "refresh_required" && object(review.state)?.refreshReason === "review_evidence_stale" &&
            Array.isArray(data?.allowedActions) && data.allowedActions.includes("prepare_review")) return "past";
        break;
      case "cancel":
        if (snapshot.reason === "cancelled") return "observed";
        break;
      case "disconnect":
        if (connection && connection.connectionId === input.connectionId && (connection.pendingAction === "disconnect" ||
            snapshot.state !== "ready" && connection.status === "disconnected")) return "observed";
        break;
      case "use_account":
        if (snapshot.reason === "completed" && data?.activeAccount === input.account && connection?.connectionId === input.connectionId) return "observed";
        break;
      case "stop_connection":
        if (sameConnection && connection?.status === "stopped") return "observed";
        if (sameConnection && connection?.status !== "awaiting_approval") return "past";
        break;
      case "stop_waiting":
        if (sameRequest && (request?.requestStatus === "stopped" || data?.observationStopped === true)) return "observed";
        if (sameRequest && ["completed", "request_failed", "outcome_unknown"].includes(String(request?.requestStatus))) return "past";
        break;
      case "read_result":
        if (sameRequest && (data?.observe === true || request?.requestStatus === "completed")) return "observed";
        if (sameRequest && ["stopped", "request_failed"].includes(String(request?.requestStatus))) return "past";
        break;
    }
    if (failedSelectionEnded()) return "past";
    // Ending command authority is not ending an admitted request or lookup.
    if (typeof data?.actionRemainingMs === "number" && data.actionRemainingMs <= 0) return "past";
    if (["connect", "disconnect", "use_account", "cancel", "prepare_review", "request_signature"].includes(String(input.action)) &&
        (snapshot.state !== "ready" || review?.status === "expired")) return "past";
    return "active";
  }
  function failedSelectionEnded(): boolean {
    const selection = workflowActionSchema.safeParse(failedCommand?.input);
    if (!selection.success || (selection.data.action !== "disconnect" && selection.data.action !== "use_account")) return false;
    const input = selection.data;
    const data = workflowViewSchema.safeParse(snapshot?.data);
    if (!data.success) return false;
    // Before admission the target lives in the owner's connection set, not in
    // this card's operation projection. Absence alone is not a terminal fact.
    const target = data.data.connections.find((item) => item.connectionId === input.connectionId);
    if (!target) return false;
    if (input.action === "disconnect") return data.data.walletAvailability.status === "available" && !target.pendingAction &&
      !data.data.manageableConnectionIds.includes(input.connectionId) &&
      ["disconnected", "failed", "rejected", "stopped", "expired"].includes(target.status);
    return ["disconnected", "failed", "rejected", "stopped", "expired"].includes(target.status) ||
      input.action === "use_account" && target.status === "connected" && !target.accounts.includes(input.account);
  }
  function reconcileFailedCommand(): void {
    if (!failedCommand) return;
    const next = classifyFailedCommand();
    // Remember facts about this attempt, not a frozen copy of wallet state. A
    // removed account returning does not turn its earlier failure into a new one.
    if (next && failedCommand.disposition !== "observed" && (next !== "active" || failedCommand.disposition === "active")) {
      failedCommand.disposition = next;
    }
    // Another card reaching the requested condition is not our admission. It
    // may make the error historical but cannot authorize another automatic send.
    if (failedCommand.disposition === "observed") failedCommand.retryRequired = false;
  }
  function retryTarget() {
    const current = automaticWorkflowActionSchema.safeParse(object(snapshot?.data)?.automaticAction);
    return failedCommand?.retryRequired && current.success && failedCommand.input.action === current.data.action ? current.data : undefined;
  }
  function commandLabel(command: Pick<CommandFlight, "input" | "basis">): string {
    const labels: Record<string, string> = {
      connect: "connection request", prepare_review: "review update", request_signature: "wallet approval request",
      read_result: "transaction status check", cancel: "cancellation request", stop_connection: "request to stop connecting",
      stop_waiting: object(object(command.basis.data)?.request)?.requestStatus === "awaiting_signature"
        ? "request to stop wallet approval" : "request to stop checking the result",
      disconnect: "wallet disconnect request", use_account: "account selection"
    };
    return business ? labels[String(command.input.action)] ?? "request" : "data request";
  }
  function historyMessage(disposition: Disposition | undefined): string | undefined {
    if (disposition !== "past" || !failedCommand) return undefined;
    const label = commandLabel(failedCommand);
    const followUp = failedCommand.input.action === "read_result" && object(object(snapshot?.data)?.request)?.requestStatus === "outcome_unknown"
      ? " To check this transaction again, ask to open its result in chat." : "";
    const message = failedCommand.message;
    return `Message from an earlier ${label}: “${message}”${followUp}`;
  }

  // All effect consumers share this decision. In particular, lack of input
  // authority must not erase an outstanding confirmation or observation.
  let downloadEndsAt: number | undefined;
  let downloadLease: string | undefined;
  function decide() {
    const data = object(snapshot?.data), download = settings ? object(data?.download) : undefined;
    const fileActions = Array.isArray(download?.allowedFileActions) ? download.allowedFileActions : [];
    const permitted = [...(Array.isArray(data?.allowedActions) ? data.allowedActions : []),
      ...fileActions.filter((action) => action === "settings_report_download" || downloadEndsAt === undefined || Date.now() < downloadEndsAt)];
    const reviewInput = kind === "review" && data?.mode === "review" && !data.request && !!reference && snapshot?.state === "ready";
    const reviewPeriodElapsed = reviewInput && reviewEndsAt !== undefined && Date.now() >= reviewEndsAt;
    const visible = document.visibilityState !== "hidden";
    const ended = lifetime.signal.aborted || confirmation.status === "rejected";
    const current = confirmation.status === "confirmed";
    const disposition = failedCommand?.disposition;
    const activeFailure = disposition === "active";
    const retryRequired = failedCommand?.retryRequired === true;
    const approvalUnresolved = failedCommand?.input.action === "request_signature" && disposition === "active";
    const paused = automation === "paused";
    const displayPending = displayedView?.pending?.() === true;
    const partialDisplayFailure = displayedView?.displayRecovery?.();
    const available = current && !ended && !displayError && !displayPending && !reviewPeriodElapsed && !!reference;
    const inputEnabled = available && !commandFlight && !settingsFileTransfer && (!interactive || !(reading && (activeFailure || retryRequired || paused)));
    const automatic = automaticWorkflowActionSchema.safeParse(data?.automaticAction);
    const observation = !!snapshot && (interactive ? data?.observe === true : snapshot.state === "running");
    const read = !!cardId && connected && !ended && !reading && visible &&
      (readRequested === "explicit" || confirmation.status !== "read_failed" &&
        (readRequested === "background" || confirmation.status === "needed" && confirmation.automatic));
    const auto = visible && available && !openingError && !reading && !readRequested && !commandFlight &&
      !retryRequired && !approvalUnresolved && !paused && business && automatic.success && permitted.includes(automatic.data.action)
      ? automatic.data : undefined;
    const restore = object(data?.restoreCheck);
    const settingsInputBlocked = settings && available && snapshot?.state === "ready" &&
      !commandFlight && !settingsFileTransfer && !data?.result && data?.observe !== true &&
      (restore?.status === "cannot_restore" && ["operation_busy", "wallet_request_unsettled"].includes(String(restore.reason)) ||
        !permitted.includes("settings_select") || !permitted.includes("settings_download_backup") || data?.phase === "prepared" && !permitted.includes("settings_confirm") ||
        data?.phase === "draft" && object(data.draft)?.kind !== undefined && object(data.draft)?.kind !== "import_local_data" && !permitted.includes("settings_prepare"));
    let recover: "read" | "retry" | undefined;
    if (!ended && cardId) {
      if (confirmation.status === "read_failed" || openingError || confirmation.status === "unconfirmed") recover = "read";
      else if (confirmation.status === "needed") { if (!confirmation.automatic) recover = "read"; }
      else if (displayError || partialDisplayFailure) recover = "read";
      else if (settings && ["pending", "failed"].includes(String(data?.temporaryFileCleanup))) recover = "read";
      else if (settingsInputBlocked) recover = "read";
      else if (!reference) { if (snapshot?.state !== "closed" || displayError) recover = "read"; }
      else if (object(data?.progress)?.status === "unavailable") recover = "read";
      else if (object(data?.walletAvailability)?.status === "initializing" && object(data?.walletAvailability)?.stage === "state_sync") recover = "read";
      else if (!paused && retryTarget()) recover = "retry";
      else if (activeFailure) {
        if (!observation && !(paused && permitted.length > 0) &&
          !(failedCommand?.input.action === "prepare_review" && permitted.includes("prepare_review") && data?.automaticAction === undefined) && business) recover = "read";
      }
    }
    const remaining = business ? data?.actionRemainingMs : snapshot?.inputRemainingMs;
    if (recover === "retry" && reviewPeriodElapsed) recover = "read";
    const nextRead = business ? data?.nextStateReadAfterMs : settings && downloadEndsAt !== undefined ? Math.max(0, downloadEndsAt - observedAt) : undefined;
    const timed = business ? permitted.length > 0 : snapshot?.state === "ready";
    const intervals = [timed ? remaining : undefined, nextRead].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const canObserve = !ended && !!reference && visible && !inputRequest && !openingError && confirmation.status !== "read_failed";
    const review = object(data?.review);
    const reviewUpdatePending = reviewInput && !ended && !openingError && !displayError && !activeFailure && !retryRequired && !paused &&
      confirmation.status !== "read_failed" && (displayPending || commandFlight?.input.action === "prepare_review" || review?.preparing === true ||
        automatic.success && automatic.data.action === "prepare_review" ||
        confirmation.status === "needed" && review?.status === "ready_for_wallet_review");
    return { current, inputEnabled, permitted, disposition, read, auto, recover, paused, partialDisplayFailure, settingsInputBlocked,
      reviewUpdatePending,
      reviewCommandDeliveryFailed: activeFailure && failedCommand?.input.action === "prepare_review",
      reviewHint: reviewPeriodElapsed ? undefined : reviewUpdatePending ? (displayPending || review?.preparing || commandFlight?.input.action === "prepare_review" ? "Updating review…" : "Checking status…") :
        reviewInput && object(review?.state)?.refreshReason === "review_evidence_stale" ? "Review details are out of date." : undefined,
      errors: [confirmation.status === "rejected" ? confirmation.message : confirmation.status === "read_failed"
        ? `This card's status could not be checked. Reported message: “${confirmation.message}”` : undefined,
        openingError && confirmation.status !== "rejected" ? `This card could not be opened. Reported message: “${openingError}”` : undefined,
        activeFailure && failedCommand ? `Message for this ${commandLabel(failedCommand)}: “${failedCommand.message}”` : undefined,
        displayError, partialDisplayFailure?.message],
      note: [selectionNotice, historyMessage(disposition)].filter(Boolean).join(" "),
      expiryAt: canObserve && current && intervals.length ? observedAt + Math.min(...intervals) : undefined,
      poll: canObserve && (observation || confirmation.status === "needed" && !confirmation.automatic),
      lifetimeAt: !ended && visible && reviewInput ? reviewEndsAt : undefined
    };
  }
  type Decision = ReturnType<typeof decide>;
  function recoveryLabel(d: Decision): string | undefined {
    return d.recover === "retry" ? failedCommand?.input.action === "connect" ? "Retry connection" : "Retry review"
      : d.recover === "read" ? "Check status" : undefined;
  }
  // The frame owns confirmation/recovery; renderers describe the domain and
  // the selection they actually display. Neither description grants authority.
  function currentGuidance(d: Decision): string {
    if (lifetime.signal.aborted) return "";
    const recoveryNeeded = d.errors.some(Boolean) || d.recover !== undefined ||
      !!snapshot && !reference && snapshot.state !== "closed" || snapshot?.state === "closed" && snapshot.reason !== "completed";
    const recoveryInstruction = d.errors.some(Boolean) || confirmation.status !== "confirmed" || d.recover === "retry" || d.settingsInputBlocked;
    if (recoveryNeeded && recoveryInstruction && confirmation.status !== "rejected") {
      if (reading || d.read) return "Checking status…";
      const label = recoveryLabel(d);
      if (label) return label === "Check status" ? displayError || d.partialDisplayFailure
        ? "Use Check status to read this card and try displaying it again." : "Use Check status to read this card again."
        : label === "Retry connection" ? "Use Retry connection to try connecting your wallet again."
        : "Use Retry review to try again with the displayed wallet and account.";
      if (canSubmit(d) && displayedView?.selectionHint) return displayedView.selectionHint;
    }
    return renderer.guidance?.(snapshot, { confirmed: d.current, readOnly: !reference, recoveryNeeded,
      visibleConfirmation: displayedView?.visibleConfirmation?.(),
      commandPending: interactive && commandFlight && d.current && !d.errors.some(Boolean) &&
        (commandFlight.phase === "confirming" || snapshot?.state === "ready" && !object(snapshot.data)?.runtimeRecovery &&
          !object(snapshot.data)?.request && !object(object(snapshot.data)?.review)?.preparing)
        ? { phase: commandFlight.phase, action: String(commandFlight.input.action) } : undefined,
      approvalUnresolved: failedCommand?.input.action === "request_signature" && d.disposition === "active" || commandFlight?.input.action === "request_signature",
      automaticPaused: d.paused }) ?? "";
  }
  function canSubmit(d = decide()): boolean { return d.inputEnabled && snapshot?.state === "ready" && displayedInput; }
  function canAct(input?: Record<string, unknown>, d = decide()): boolean {
    return interactive && d.inputEnabled && (input ? d.permitted.includes(input.action) : d.permitted.length > 0);
  }
  function canSendFileInput(input: Record<string, unknown>): boolean {
    const d = decide();
    return settings && settingsFileTransfer && d.current && !!reference && !commandFlight && !reading && !displayError &&
      !lifetime.signal.aborted && ["settings_begin_upload", "settings_upload_chunk", "settings_seal_upload", "settings_retry_download", "settings_report_download", "settings_cancel_download"].includes(String(input.action)) && d.permitted.includes(input.action);
  }
  function updateChrome(d: Decision): void {
    const workflow = object(snapshot?.data);
    const feedback = content.querySelector<HTMLElement>(".review-action-feedback");
    const primaryAction = content.querySelector<HTMLButtonElement>(".review-primary-action");
    // These are the existing lifecycle indicators, moved rather than copied.
    // Other card surfaces keep the ordinary status/error placement.
    if (primaryAction && feedback) {
      const timeRow = content.querySelector<HTMLElement>(".review-lifetime");
      if (timeRow) { timeRow.append(progressHint); feedback.prepend(issue); }
      else feedback.prepend(progressHint, issue);
      feedback.append(notice);
    }
    else { root!.insertBefore(issue, content); root!.insertBefore(progressHint, actions); root!.insertBefore(notice, progressHint); }
    issue.className = primaryAction ? "ui-note" : "ui-error";
    if (snapshot) {
      heading.textContent = renderer.titleFor?.(snapshot) ?? renderer.title;
      status.textContent = confirmation.status === "rejected" ? "Card unavailable" :
        !d.current && snapshot.state === "ready" ? (primaryAction ? "" : !lifetime.signal.aborted && (reading || d.read) ? "Checking whether actions are available in this card…" : "Actions are unavailable until this card's status is checked.") :
        !reference && snapshot.state !== "closed" ? "View only." :
        interactive ? (object(workflow?.progress)?.status === "unavailable" ? "Current progress is unavailable. The last recorded state is shown." :
          !workflow?.request && snapshot.state === "closed" && ["expired", "server_restarted", "cancelled"].includes(snapshot.reason ?? "")
            ? "This card no longer accepts actions." : "") :
        snapshot.state === "running" ? "Reading the requested data…" : snapshot.reason === "completed" ? "" : snapshot.error ??
        (snapshot.reason === "expired" ? "The time to make a selection has ended." :
          snapshot.reason === "server_restarted" ? "This request ended when Sui MCP restarted." : "");
    } else status.textContent = inputRequest ? "" : confirmation.status === "read_failed" ? "Card status unavailable" : openingError || confirmation.status === "rejected" ? "Card unavailable" : "Opening card…";
    status.hidden = !status.textContent;
    issue.textContent = [...new Set(d.errors.filter(Boolean))].join(" ");
    issue.hidden = !issue.textContent;
    const reviewStatus = content.querySelector<HTMLElement>(".review-status");
    if (reviewStatus) reviewStatus.hidden = !!primaryAction && (d.reviewUpdatePending || !!issue.textContent);
    const materialStatus = content.querySelector<HTMLElement>(".review-material-status");
    if (materialStatus) materialStatus.textContent = materialStatus.dataset.previous === "true" || !d.current || d.reviewUpdatePending
      ? materialStatus.dataset.previousLabel ?? "" : materialStatus.dataset.currentLabel ?? "";
    notice.textContent = [d.note, currentGuidance(d)].filter(Boolean).join(" ");
    notice.hidden = !notice.textContent;
    if (displayedInput) for (const control of content.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select")) {
      if (!interactive || control.tagName !== "BUTTON" || control.dataset.cardAction !== undefined) control.disabled = interactive ? !canAct(undefined, d) : !canSubmit(d);
    }
    if (interactive) for (const control of content.querySelectorAll<HTMLButtonElement>("[data-card-action]")) control.disabled = !canAct({ action: control.dataset.cardAction }, d);
    if (settings) for (const control of content.querySelectorAll<HTMLButtonElement>("[data-settings-file-action]")) {
      control.disabled = control.dataset.settingsLocalBlocked === "true" ||
        !(settingsFileTransfer ? canSendFileInput({ action: control.dataset.cardAction }) : canAct({ action: control.dataset.cardAction }, d));
    }
    if (primaryAction && (d.reviewUpdatePending || primaryAction.dataset.cardAction === "request_signature" && d.reviewCommandDeliveryFailed || primaryAction.dataset.cardAction === undefined)) primaryAction.disabled = true;
    if (recovery) recovery.disabled = !!commandFlight || !!reading;
  }
  function release(dispose: (() => void) | undefined): void {
    try { dispose?.(); }
    catch { displayError = "The card display could not be closed cleanly. Its stored information is unchanged."; }
  }
  function render(retryFailed: boolean): void {
    if (!snapshot || lifetime.signal.aborted) return;
    // A creating response is a display snapshot, never input authority.
    if (snapshot.state === "ready" && confirmation.status !== "confirmed") {
      // Retire local response progress without creating input from an
      // unconfirmed snapshot. Existing controls remain locked by the lifecycle.
      if (settings && displayedView?.update) {
        try { displayedView.update(snapshot, { automaticPaused: automation === "paused", settings: settingsTransport,
          settingsCommandProgress: undefined, onDisplayChange: () => publish() }); }
        catch { displayError = "This card could not be displayed. Its stored information is unchanged."; }
      }
      return;
    }
    if (snapshot.state === "running" && !interactive) { displayError = undefined; return; }
    // Workflow projections include referenced connection/account facts. Those
    // may change while this already-consumed card's own revision stays fixed.
    // Remaining milliseconds affect timers, not the displayed content identity.
    const projection = interactive ? { ...object(snapshot.data), actionRemainingMs: undefined, nextStateReadAfterMs: undefined,
      ...(settings && object(snapshot.data)?.download ? { download: { ...object(object(snapshot.data)?.download), remainingMs: undefined } } : {}) } : undefined;
    const settingsProgress = settings && commandFlight?.phase === "sending" && confirmation.status === "confirmed"
      ? settingsCommandProgress(commandFlight.basis, snapshot, commandFlight.input) : undefined;
    const key = `${automation === "paused"}:${JSON.stringify(settingsProgress)}:${snapshot.revision}:${reference !== undefined}:${display !== undefined}:${walletDisplay !== undefined}:${JSON.stringify(projection)}`;
    if (key === renderedKey || (key === attemptedKey && !retryFailed)) return;
    attemptedKey = key;
    const previousNodes = [...content.children];
    const openDetails = new Set([...content.querySelectorAll<HTMLDetailsElement>("details")]
      .filter((item) => item.open).map((item) => item.querySelector("summary")?.textContent));
    let candidate: ReturnType<CardRenderer["result"]> | undefined;
    let nextInput = false;
    let inserted = false;
    try {
      const context: CardViewContext = { automaticPaused: automation === "paused", onDisplayChange: () => publish(),
        ...(settings ? { settings: settingsTransport, settingsCommandProgress: settingsProgress } : {}) };
      if (displayedView?.update?.(snapshot, context)) {
        renderedKey = key; displayError = undefined; return;
      }
      if (snapshot.state === "ready" && reference) {
        const controls = renderer.controls(snapshot, (input) => { void submit(input); }, display, walletDisplay, context);
        candidate = "node" in controls ? controls : { node: controls };
        nextInput = true;
      } else if ((interactive || snapshot.reason === "completed") && snapshot.data !== undefined) {
        candidate = renderer.result(snapshot, display, reference ? (input) => { void submit(input); } : undefined, walletDisplay, context);
      }
      content.replaceChildren(...(candidate ? [candidate.node] : [])); inserted = true;
      candidate?.mount?.();
      for (const item of content.querySelectorAll<HTMLDetailsElement>("details")) {
        if (openDetails.has(item.querySelector("summary")?.textContent)) item.open = true;
      }
    } catch {
      if (inserted) content.replaceChildren(...previousNodes);
      release(candidate?.dispose);
      displayError = "This card could not be displayed. Its stored information is unchanged.";
      return;
    }
    const previousDispose = displayedView?.dispose;
    displayedView = candidate;
    displayedInput = nextInput;
    renderedKey = key;
    displayError = undefined;
    release(previousDispose);
  }
  function acceptSnapshot(next: CardSnapshot, details: CardReceiptDisplay | undefined, source: "preview" | "read" | "action", wallet?: CardWalletDisplay, readId?: number): boolean {
    if (lifetime.signal.aborted || confirmation.status === "rejected") return false;
    if (next.kind !== kind || next.cardId !== cardId) {
      confirmation = { status: "rejected", message: "The returned information does not match this card." };
      throw new Error("The returned information does not match this card.");
    }
    const data = object(next.data), request = object(data?.request), execution = object(request?.execution);
    const automatic = data?.automaticAction === undefined ? undefined : automaticWorkflowActionSchema.safeParse(data.automaticAction);
    if (automatic && !automatic.success) throw new Error("This card could not start the next step.");
    // Same-card successful history is not an identity or transport failure.
    // Admission may have fixed a previously empty Chart input in the meantime.
    if (snapshot && next.revision < snapshot.revision) return false;
    if (boundInput && [...new Set([...Object.keys(boundInput), ...Object.keys(next.input)])]
        .some((key) => JSON.stringify(next.input[key]) !== JSON.stringify(boundInput![key]))) {
      confirmation = { status: "rejected", message: "The returned information does not match this card." };
      throw new Error("The returned information does not match this card.");
    }
    if ((kind === "review" && ((object(data?.review)?.reviewSessionId !== undefined && object(data?.review)?.reviewSessionId !== next.input.reviewSessionId) ||
        (request && (request.reviewSessionId !== next.input.reviewSessionId ||
          (next.input.attemptId !== undefined && request.attemptId !== next.input.attemptId))) ||
        (execution && (execution.reviewSessionId !== request?.reviewSessionId || execution.attemptId !== request?.attemptId || execution.txDigest !== request?.transactionDigest)) ||
        (object(data?.receipt)?.status === "found" && object(object(data?.receipt)?.receipt)?.txDigest !== request?.transactionDigest))) ||
        (kind === "receipt" && data?.status === "found" && object(data.receipt)?.txDigest !== next.input.digest)) {
      confirmation = { status: "rejected", message: "The saved result does not match the information requested in this card." };
      throw new Error(confirmation.message);
    }
    // Read-card inputs become fixed after admission; workflow targets are fixed
    // when created. A ready read form can still accept the user's first choice.
    if (!boundInput && (business || next.state !== "ready")) boundInput = { ...next.input };
    const current = source !== "preview";
    if (!snapshot || next.revision !== snapshot.revision) { display = undefined; walletDisplay = undefined; }
    snapshot = next;
    reconcileFailedCommand();
    if (current) {
      observedAt = Date.now();
      const download = settings ? object(data?.download) : undefined;
      if (download?.availability === "available" && typeof download.remainingMs === "number" && Number.isFinite(download.remainingMs)) {
        const key = `${data?.operationId}:${object(data?.file)?.fileId}:${download.expiresAt}`;
        if (downloadLease !== key) { downloadLease = key; downloadEndsAt = undefined; }
        downloadEndsAt = Math.min(downloadEndsAt ?? Infinity, observedAt + Math.max(0, download.remainingMs));
      } else if (settings && download?.availability === "ended") downloadEndsAt = undefined;
      if (reference && kind === "review" && data?.mode === "review" && !data.request &&
          typeof data.actionRemainingMs === "number" && Number.isFinite(data.actionRemainingMs) && data.actionRemainingMs >= 0) {
        // Relative backend authority is independent of the local wall-clock
        // date. A fresh read or retry may shorten, never extend, this deadline.
        reviewEndsAt = Math.min(reviewEndsAt ?? Infinity, observedAt + data.actionRemainingMs);
      }
    }
    if (source === "read" && (confirmation.status !== "needed" || readId! > confirmation.afterRead)) {
      confirmation = { status: "confirmed" };
      openingError = undefined;
    }
    if (details) display = details;
    walletDisplay = wallet;
    return true;
  }
  function clearTimers(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    timer = undefined; expiryTimer = undefined; lifetimeTimer = undefined; progressHint.hidden = true;
  }
  function updateRecovery(d: Decision): void {
    const label = recoveryLabel(d);
    if (recovery?.textContent !== label) {
      recovery?.remove(); recovery = undefined;
      if (label) {
        recovery = button(label, () => {
          if (reading || commandFlight || lifetime.signal.aborted) return;
          if (decide().recover === "retry") { const target = retryTarget(); if (target) void confirmAndSubmit(target); }
          else void recoverDisplay();
        });
      }
    }
    const primary = content.querySelector<HTMLButtonElement>(".review-primary-action");
    const slot = content.querySelector<HTMLElement>(".review-primary-slot");
    if (primary) primary.hidden = !!recovery && !!slot;
    if (recovery) {
      recovery.disabled = !!reading || !!commandFlight;
      if (slot) { recovery.classList.add("review-recovery-action"); slot.append(recovery); }
      else { recovery.classList.remove("review-recovery-action"); actions.append(recovery); }
    }
  }
  async function recoverDisplay(): Promise<void> {
    const view = displayedView, failure = view?.displayRecovery?.();
    const result = await requestRead(true);
    // A successful current read retries a failed whole render in publish(). A
    // partial resource needs this explicit intent, not every poll or visibility
    // read. Replacement/disposal must not retry the previous view's resource.
    if (result?.kind === "accepted" && snapshot === result.snapshot && confirmation.status === "confirmed" &&
        !lifetime.signal.aborted && document.visibilityState !== "hidden" && !displayError &&
        view === displayedView && failure && view?.displayRecovery?.() === failure) {
      failure.retry();
      publish();
    }
  }
  function publish(retryRender = false): void {
    if (inputRequest) {
      const message = document.createElement("p"); message.className = "ui-note"; message.textContent = inputRequest;
      content.replaceChildren(message);
    } else render(retryRender);
    const d = decide(); updateChrome(d); clearTimers();
    updateRecovery(d);
    if (lifetime.signal.aborted || confirmation.status === "rejected") return;
    if (d.expiryAt !== undefined) expiryTimer = setTimeout(() => { requireConfirmation(); publish(); }, Math.max(0, d.expiryAt - Date.now()));
    if (d.reviewHint && !issue.textContent) {
      progressHint.replaceChildren(); progressHint.textContent = d.reviewHint;
      progressHint.setAttribute("role", "status"); progressHint.hidden = false;
    }
    const remaining = content.querySelector<HTMLElement>(".review-time-remaining");
    if (remaining && d.lifetimeAt !== undefined) {
      const deadline = d.lifetimeAt;
      const tick = () => {
        if (lifetime.signal.aborted) return;
        const left = Math.max(0, deadline - Date.now()), seconds = Math.ceil(left / 1000);
        remaining.textContent = left > 0
          ? `Review expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
          : "Review time elapsed";
        if (left > 0) lifetimeTimer = setTimeout(tick, Math.min(1000, left));
        else { const expired = decide(); updateChrome(expired); updateRecovery(expired); }
      };
      tick();
    }
    if (d.poll && snapshot) {
      const left = observedAt + snapshot.pollAfterMs - Date.now();
      timer = setTimeout(() => { requestRead(false); }, left > 0 ? left : snapshot.pollAfterMs);
    }
    if (d.read) { readRequested = undefined; startRead(); }
    else if (d.auto) timer = setTimeout(() => { const current = decide().auto; if (current) void sendCommand(current, "automatic"); }, 0);
  }
  function requireConfirmation(): void {
    if (confirmation.status !== "rejected" && confirmation.status !== "read_failed") {
      confirmation = { status: "needed", afterRead: readSerial, automatic: true };
    }
  }
  function requestRead(explicit: boolean): Promise<ReadOutcome | undefined> {
    if (lifetime.signal.aborted || confirmation.status === "rejected" || !cardId || !connected) return Promise.resolve(undefined);
    if (reading) return reading.promise;
    if (confirmation.status === "read_failed" && !explicit) return Promise.resolve(undefined);
    readRequested = explicit ? "explicit" : "background";
    publish();
    return (reading as ReadFlight | undefined)?.promise ?? Promise.resolve(undefined);
  }
  function startRead(): void {
    const id = ++readSerial, requestStartedAt = performance.now();
    // Install the complete single-flight handle before a Host call can re-enter.
    const work = Promise.resolve().then(async (): Promise<ReadOutcome> => {
      try {
        let next: CardSnapshot, details: CardReceiptDisplay | undefined, wallet: CardWalletDisplay | undefined;
        if (reference) {
          const result = responseParts(await call(CARD_TOOLS.read, reference));
          if (!result.snapshot) throw new Error(result.error ?? "Saved card data is unavailable.");
          if (result.error) throw new Error(result.error);
          next = result.snapshot; details = result.display; wallet = result.wallet;
        } else {
          const uri = `${CARD_RESOURCE_PREFIX}${encodeURIComponent(cardId!)}`;
          const saved = await app.readServerResource({ uri }, { signal: lifetime.signal });
          const item = saved.contents.find((entry) => entry.uri === uri && "text" in entry);
          if (!item || !("text" in item)) throw new Error("Saved card data is unavailable.");
          next = cardSnapshotSchema.parse(JSON.parse(item.text));
          const prior = display ?? creatingDisplay; details = prior && matchingDisplay(next, prior) ? prior : undefined;
        }
        if (lifetime.signal.aborted || confirmation.status === "rejected") return { kind: "disposed", id };
        const accepted = acceptSnapshot(next, details, "read", wallet, id);
        creatingDisplay = undefined;
        if (!accepted && confirmation.status === "needed" && id > confirmation.afterRead) {
          // This required read really ran but lost the revision race. Keep its
          // obligation, using the existing next observation or explicit read.
          confirmation = { ...confirmation, automatic: false };
        }
        publish(accepted);
        return accepted && confirmation.status === "confirmed" ? { kind: "accepted", snapshot: next, id, requestStartedAt } : { kind: "ignored", id };
      } catch (error) {
        if (lifetime.signal.aborted) return { kind: "disposed", id };
        if (confirmation.status !== "rejected") confirmation = { status: "read_failed", message: error instanceof Error ? error.message : "Saved card data could not be read. The last displayed result is unchanged." };
        return { kind: "failed", id };
      }
    });
    const flight: ReadFlight = { id, promise: work.finally(() => { if (reading === flight) reading = undefined; publish(); }) };
    reading = flight;
    publish();
  }
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return unwrap(await app.callServerTool({ name, arguments: args }, { signal: lifetime.signal }), app.getHostVersion()?.name);
  }
  function targetStillCurrent(input: Record<string, unknown>, before: CardSnapshot, current: CardSnapshot): boolean {
    const parsed = workflowViewSchema.safeParse(current.data);
    if (!parsed.success || !parsed.data.allowedActions.some((action) => action === input.action)) return false;
    const data = parsed.data, prior = object(before.data);
    if (input.walletRunId && input.walletRunId !== data.walletAvailability.walletRunId) return false;
    if (input.action === "connect") return data.allowedActions.includes("connect") && ["connect", "manage"].includes(String(current.input.intent));
    if (input.action === "prepare_review" || input.action === "request_signature") {
      return data.review?.reviewRevision === input.reviewRevision &&
        (input.action === "prepare_review" ? data.assetReadAccount?.status === "available" ? data.assetReadAccount.account : undefined : data.review?.account) === input.account &&
        reviewWalletChoices(data, String(input.account), input.action === "request_signature").some((item) => item.connectionId === input.connectionId);
    }
    if (input.action === "disconnect") return data.manageableConnectionIds.includes(String(input.connectionId)) &&
      data.connections.some((item) => item.connectionId === input.connectionId && !item.pendingAction);
    if (input.action === "use_account") return data.connections.some((item) => item.connectionId === input.connectionId &&
      item.status === "connected" && !item.pendingAction && item.connectionId === data.usableConnectionId && item.accounts.includes(String(input.account)));
    return data.connection?.connectionId === object(prior?.connection)?.connectionId &&
      data.request?.attemptId === object(prior?.request)?.attemptId &&
      data.review?.reviewRevision === object(prior?.review)?.reviewRevision;
  }
  async function confirmAndSubmit(input: Record<string, unknown>): Promise<void> {
    if (!snapshot || reading || !canAct(input)) return;
    const flight: CommandFlight = { input, basis: snapshot, phase: "confirming" };
    commandFlight = flight;
    const result = await requestRead(false);
    if (commandFlight !== flight) return;
    commandFlight = undefined;
    if (result?.kind === "accepted" && snapshot === result.snapshot && confirmation.status === "confirmed" &&
        !lifetime.signal.aborted && document.visibilityState !== "hidden" && targetStillCurrent(input, flight.basis, result.snapshot) && canAct(input)) {
      await sendCommand(input);
    } else if (confirmation.status !== "read_failed" && confirmation.status !== "rejected" && !lifetime.signal.aborted) {
      selectionNotice = "The card state changed. Check the current selection before trying again.";
    }
    publish();
  }
  async function submit(input: Record<string, unknown>): Promise<void> {
    if (business && (failedCommand?.disposition === "active" || failedCommand?.retryRequired || automation === "paused")) await confirmAndSubmit(input);
    else await sendCommand(input);
  }
  function recordCommandFailure(flight: CommandFlight, message: string, delivery: FailedCommand["delivery"]): void {
    failedCommand = { input: flight.input, basis: flight.basis, message, delivery, disposition: "active",
      retryRequired: flight.input.action === "connect" || flight.input.action === "prepare_review" };
    reconcileFailedCommand();
    if (["cancel", "disconnect", "stop_connection", "stop_waiting", "use_account"].includes(String(flight.input.action))) automation = "paused";
    if (interactive || delivery === "unknown") requireConfirmation();
  }
  async function sendCommand(input: Record<string, unknown>, origin: "user" | "automatic" | "file" = "user"): Promise<void> {
    if (!snapshot || !reference || (origin === "file" ? !canSendFileInput(input) : interactive ? !canAct(input) : !canSubmit())) return;
    const flight: CommandFlight = { input, basis: snapshot, phase: "sending" };
    commandFlight = flight; automation = "continue";
    if (origin === "user" || failedCommand?.disposition !== "past") failedCommand = undefined;
    selectionNotice = undefined;
    publish();
    try {
      const result = responseParts(await call(interactive ? CARD_TOOLS.act : CARD_TOOLS.submit, { ...reference, revision: flight.basis.revision, input }));
      if (lifetime.signal.aborted || confirmation.status === "rejected") return;
      if (!result.snapshot) throw new Error(result.error ?? "The request could not be confirmed.");
      if (result.error) recordCommandFailure(flight, result.error, "rejected");
      acceptSnapshot(result.snapshot, result.display, "action", result.wallet);
    } catch (error) {
      if (!lifetime.signal.aborted && confirmation.status !== "rejected") {
        recordCommandFailure(flight, error instanceof Error ? error.message : "The request could not be confirmed.", "unknown");
        if (failedCommand) failedCommand.data = object(error)?.data;
      }
    } finally {
      if (commandFlight === flight) commandFlight = undefined;
      publish();
    }
  }
  const settingsTransport: SettingsViewTransport = {
    uploadChunkLimit(operationId, fileId) {
      if (!reference) return 0;
      return settingsUploadMessageBudget({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: "tools/call",
        params: { name: CARD_TOOLS.act, arguments: { ...reference, revision: Number.MAX_SAFE_INTEGER,
          input: { action: "settings_upload_chunk", operationId, fileId, offset: Number.MAX_SAFE_INTEGER, chunkBase64: "" } } } }) ?? 0;
    },
    async readCurrent() {
      const result = await requestRead(true);
      if (result?.kind !== "accepted") throw new Error("The current Settings selection could not be checked. Use Check status before continuing.");
      return { snapshot: result.snapshot, requestStartedAt: result.requestStartedAt };
    },
    async act(input, fileTransfer = false) {
      if (fileTransfer ? !canSendFileInput(input) : !canAct(input)) throw new Error("This Settings action is unavailable until its current status has been checked.");
      await sendCommand(input, fileTransfer ? "file" : "user");
      if (lifetime.signal.aborted) throw new Error("This card closed before the request finished. Reopen the same conversation to check its status.");
      if (failedCommand?.input === input) {
        const error = new Error(failedCommand.message) as Error & { data?: unknown };
        error.data = failedCommand.data;
        throw error;
      }
      if (!snapshot) throw new Error("The current Settings status could not be checked.");
      return snapshot;
    },
    setFileTransferActive(active) { settingsFileTransfer = active; publish(); },
    async readFile(input) {
      if (!reference || !cardId || !decide().current || lifetime.signal.aborted) throw new Error("Backup read permission is unavailable.");
      const response = await call(CARD_TOOLS.readSettingsFile, { ...reference, ...input });
      const value = settingsFileDisplaySchema.parse(object(response._meta)?.[SETTINGS_FILE_METADATA_KEY]);
      if (value.cardId !== cardId || value.operationId !== input.operationId || value.fileId !== input.fileId || value.offset !== input.offset || value.attemptId !== input.attemptId) throw new Error("The backup response does not match this card's selected file.");
      return value;
    },
    download: (filename, base64, attemptId) => {
      const data = object(snapshot?.data), download = object(data?.download);
      if (!reference || !decide().current || lifetime.signal.aborted || document.visibilityState === "hidden" ||
          (download && (download.currentAttemptId !== attemptId || download.availability !== "available" ||
            downloadEndsAt === undefined || Date.now() >= downloadEndsAt))) throw new Error("This download is no longer available in this card.");
      return app.downloadFile({ contents: [{ type: "resource", resource: {
        uri: `file:///${encodeURIComponent(filename)}`, mimeType: "application/json", blob: base64
      } }] }, { signal: lifetime.signal });
    }
  };
  async function initialize(): Promise<void> {
    if (!connected || creating === undefined || initialized) return;
    initialized = true;
    try {
      const result = unwrap(creating, app.getHostVersion()?.name);
      const meta = object(result._meta);
      if (result._meta !== undefined && !meta) throw new Error("This card cannot accept actions with the access information provided by the app.");
      const rawReference = meta?.[CARD_METADATA_KEY];
      if (rawReference !== undefined) {
        const privateResult = cardReferenceSchema.safeParse(rawReference);
        if (!privateResult.success) throw new Error("This card cannot accept actions with the access information provided by the app.");
        reference = privateResult.data;
      }
      const initial = responseParts(result);
      if (initial.inputRequired) {
        if (initial.inputRequired.kind !== kind || reference) throw new Error("The app provided inconsistent card input information.");
        inputRequest = initial.inputRequired.message;
        publish();
        return;
      }
      const linkedId = linkedCardId(result, app.getHostVersion()?.name);
      const ids = [initial.snapshot?.cardId, reference?.cardId, linkedId].filter((id): id is string => id !== undefined);
      if (!ids.length) throw new Error("Card data is unavailable.");
      if (ids.some((id) => id !== ids[0]) || (initial.snapshot && initial.snapshot.kind !== kind)) {
        confirmation = { status: "rejected", message: "The returned information does not match this card." }; throw new Error(confirmation.message);
      }
      cardId = ids[0];
      const preview = initial.snapshot;
      if (preview && (business || preview.state !== "ready")) boundInput = { ...preview.input };
      creatingDisplay = initial.display;
      // A stale creating snapshot never replaces a current public read. With
      // permission, keep the existing preview and authenticated-read behavior.
      if (preview && reference) acceptSnapshot(preview, initial.display, "preview", initial.wallet);
      requireConfirmation();
      publish();
    } catch (error) {
      if (lifetime.signal.aborted) return;
      openingError = error instanceof Error ? error.message : "Card data could not be read.";
      publish();
    }
  }
  app.ontoolresult = (result: CallToolResult) => {
    if (creating === undefined) { creating = result; void initialize(); return; }
    try {
      const first = responseParts(unwrap(creating, app.getHostVersion()?.name)).snapshot ?? snapshot;
      const next = responseParts(unwrap(result, app.getHostVersion()?.name)).snapshot;
      if (first && next && (first.cardId !== next.cardId || first.kind !== next.kind)) throw new Error("The app returned a different card.");
      // Replayed creating responses do not overwrite the current DB revision.
    } catch {
      confirmation = { status: "rejected", message: "The returned information does not match this card." };
      publish();
    }
  };
  app.onhostcontextchanged = (context) => { if (context.theme) document.documentElement.dataset.theme = context.theme; };
  const onVisibility = () => {
    if (document.visibilityState !== "hidden" && reference && initialized && confirmation.status !== "read_failed") requestRead(false);
    else publish();
  };
  document.addEventListener?.("visibilitychange", onVisibility);
  app.onteardown = async () => {
    if (lifetime.signal.aborted) return {};
    lifetime.abort();
    commandFlight = undefined;
    document.removeEventListener?.("visibilitychange", onVisibility);
    const dispose = displayedView?.dispose; displayedView = undefined; release(dispose);
    publish();
    return {};
  };
  void app.connect().then(() => {
    if (lifetime.signal.aborted) return;
    connected = true; document.documentElement.dataset.theme = app.getHostContext()?.theme ?? "light";
    void initialize();
  }).catch(() => { if (!lifetime.signal.aborted) { openingError = "Could not connect this card to the app."; publish(); } });
}
