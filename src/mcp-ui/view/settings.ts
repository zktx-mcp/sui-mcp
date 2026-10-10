import { settingsViewSchema, SETTINGS_IMPORT_MAX_SIZE, type SettingsDraft } from "../../core/session/settingsOperation.js";
import type { CardSnapshot } from "../contracts.js";
import { section, accordion, element, row, mono, button, buttonRow, endRow, field, input, timeValue, type ButtonVariant } from "../../../review-app/src/ui/ui.js";
import { uploadSettingsFile, downloadSettingsFile, type SettingsDownloadStatus, type SettingsUploadProgress } from "./settingsFiles.js";
import type { CardRenderer, CardViewContext, CardDisplayRecovery, SettingsViewTransport } from "./lifecycle.js";
import { CONNECTION_RECONCILIATION_MESSAGE, walletRecoveryImpactSchema, type WalletConnection, type WalletRecoveryImpact } from "../../core/session/walletConnection.js";

type Page = "overview" | "address" | "records" | "troubleshooting" | "advanced";
type Route = { kind: "section"; page: Page } | { kind: "operation"; operation: SettingsDraft["kind"] };
const operationLabels: Record<SettingsDraft["kind"], string> = {
  set_endpoint: "Change network address", restore_endpoint: "Use default network address", clear_read_address: "Clear default address",
  download_backup: "Backup", export_local_data: "Backup", import_local_data: "Restore", reset_local_data: "Reset", restart_wallet_service: "Connection service restart"
};
const pageLabels: Record<Page, string> = { overview: "Settings", address: "Address for viewing assets", records: "Local records",
  troubleshooting: "Troubleshooting", advanced: "Advanced settings" };
const menuDescriptions = { address: "View or clear the address used by default when checking your assets.", records: "Back up, restore or delete records saved on this computer.",
  troubleshooting: "Check or restart the wallet connection service.", advanced: "Change the Sui network addresses used to retrieve data and send transactions." };
const recordScope = "Local records are saved addresses, reviews, transaction and activity records, and Sui network settings on this computer. They do not include wallet keys, wallet connections or wallet approvals.";
const restartApps = "Fully quit every app using Sui MCP, then reopen them. Closing a window or quitting only one app may leave Sui MCP running.";
const serviceLabels = { available: "Ready", initializing: "Starting", recovering: "Restarting", unavailable: "Unavailable" };
const sourceLabels = { environment: "App launch settings", local_db: "Saved in Sui MCP", builtin_default: "Built-in default" };
const connectionLabels: Record<WalletConnection["status"], string> = { connected: "Connected", awaiting_approval: "Waiting for wallet approval",
  rejected: "Rejected", failed: "Failed", expired: "Expired", stopped: "Stopped", disconnected: "Disconnected" };
const recordLabels = [["accounts", "Saved addresses"], ["reviewSessions", "Reviews"], ["reviewRequests", "Transaction requests"],
  ["outcomeUnknownRequests", "Transaction requests with unconfirmed results"], ["externalActivityTransactions", "Activity records"], ["localSettings", "Saved network settings"]] as const;
const titles: Record<SettingsDraft["kind"], string> = {
  set_endpoint: "Save network address?", restore_endpoint: "Use default network address?", clear_read_address: "Clear the default address for viewing assets?",
  download_backup: "Download backup", export_local_data: "Back up local records?", import_local_data: "Restore available", reset_local_data: "Reset local data?",
  restart_wallet_service: "Restart connection service?"
};
const finalLabels: Record<SettingsDraft["kind"], string> = {
  set_endpoint: "Save network address", restore_endpoint: "Use default network address", clear_read_address: "Clear default address",
  download_backup: "Download backup", export_local_data: "Create backup", import_local_data: "Restore local records", reset_local_data: "Reset local data",
  restart_wallet_service: "Restart connection service"
};
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function pageFor(kind?: SettingsDraft["kind"]): Page {
  return kind === "clear_read_address" ? "address" : kind === "set_endpoint" || kind === "restore_endpoint" ? "advanced"
    : kind === "restart_wallet_service" ? "troubleshooting" : kind ? "records" : "overview";
}
function counts(node: HTMLElement, value: unknown, label: string): void {
  const facts = object(value); node.append(element("h3", undefined, label));
  for (const [key, title] of recordLabels) {
    if (typeof facts[key!] === "number") node.append(row(title!, String(facts[key!])));
  }
}
function view(snapshot: CardSnapshot, act: ((input: Record<string, unknown>) => void) | undefined, context: CardViewContext | undefined) {
  let state = settingsViewSchema.parse(snapshot.data), currentSnapshot = snapshot;
  let route: Route = state.draft ? { kind: "operation", operation: state.draft.kind } : { kind: "section", page: "overview" }, disposed = false;
  let transport: SettingsViewTransport | undefined = context?.settings;
  let changed = context?.onDisplayChange;
  let fileNotice: { cardId: string; operationId: string; revision: number; draft: string; fileId: string | undefined; message: string } | undefined;
  let fileWork = false, downloadStatus: SettingsDownloadStatus | undefined;
  let commandProgress = context?.settingsCommandProgress;
  let downloadJob: { attemptId: string; phase: "admitting" | "waiting" | "sending" } | undefined;
  let pendingReport: { operationId: string; fileId: string; attemptId: string; status: "acknowledged" | "not_completed" | "unconfirmed" | "unsupported";
    failure?: { method: "ui/download-file"; code: -32601 } } | undefined;
  let reportRecovery: CardDisplayRecovery | undefined;
  let displayedDepth: number | undefined;
  let uploadJob: { startingRevision: number; progress: SettingsUploadProgress | undefined } | undefined;
  const node = element("div", "settings-card");
  const action = (label: string, value: Record<string, unknown>, variant: ButtonVariant = "secondary") => {
    const control = button(label, () => { if (!disposed && !fileWork) act?.(value); }, variant);
    control.dataset.cardAction = String(value.action); return control;
  };
  const navigate = (label: string, target: Route) => {
    const control = button(label, () => {
      if (disposed) return;
      const previous = route.kind === "section" ? route.page : pageFor(route.operation); route = target; render();
      const focus = target.kind === "section" && target.page === "overview"
        ? [...node.querySelectorAll<HTMLButtonElement>(".settings-menu-item")].find((item) => item.dataset.settingsPage === previous)
        : node.querySelector<HTMLButtonElement>(".settings-back");
      focus?.focus(); changed?.();
    }, "secondary");
    control.setAttribute("aria-label", label); control.dataset.settingsPage = target.kind === "section" ? target.page : pageFor(target.operation); return control;
  };
  const select = (label: string, draft: SettingsDraft, danger = false, replaceSelection = false) => {
    const control = button(label, () => {
      if (disposed || fileWork) return;
      if (!replaceSelection && state.draft && JSON.stringify(state.draft) === JSON.stringify(draft)) {
        route = { kind: "operation", operation: draft.kind }; render(); changed?.();
      } else { fileNotice = undefined; act?.({ action: "settings_select", draft }); }
    }, danger ? "danger" : "secondary");
    control.dataset.cardAction = "settings_select"; return control;
  };
  function choice(title: string, description: string, control: HTMLButtonElement): HTMLElement {
    const item = element("div", "settings-choice"), copy = element("div", "settings-choice-copy");
    copy.append(element("h3", undefined, title), element("p", "ui-note", description));
    item.append(copy, control); return item;
  }
  function operationActions(primary: HTMLElement): HTMLElement {
    const controls = element("div", "settings-action-row");
    controls.setAttribute("aria-label", "Settings operation actions");
    controls.append(primary);
    return controls;
  }
  async function reportDownload(): Promise<void> {
    if (!transport || !pendingReport || disposed) return;
    const report = pendingReport; reportRecovery = undefined;
    transport.setFileTransferActive(true);
    try {
      await transport.act({ action: "settings_report_download", ...report }, true);
      if (pendingReport === report) pendingReport = undefined;
    } catch {
      if (!disposed && pendingReport === report) reportRecovery = {
        message: "The download response could not be recorded. Check status to record the same response without downloading again.",
        retry: () => { if (pendingReport === report) void reportDownload(); }
      };
    }
    finally { if (!disposed) { transport.setFileTransferActive(!!downloadJob); render(); changed?.(); } }
  }
  function maybeDeliverDownload(): void {
    const job = downloadJob;
    if (!transport || disposed || !job || job.phase !== "waiting" || state.download?.availability !== "available" || state.download.localSave ||
        state.download.currentAttemptId !== job.attemptId || !state.file) return;
    job.phase = "sending";
    const file = { operationId: state.operationId, ...state.file, attemptId: job.attemptId };
    void downloadSettingsFile(file, transport, (status) => {
      if (downloadJob !== job || disposed) return;
      downloadStatus = status; render(); changed?.();
    }, () => !disposed && downloadJob === job && document.visibilityState !== "hidden" &&
      state.download?.currentAttemptId === job.attemptId && state.download.availability === "available").then(async (status) => {
      if (!disposed && status && ["acknowledged", "not_completed", "unconfirmed", "unsupported"].includes(status)) {
        pendingReport = { operationId: file.operationId, fileId: file.fileId, attemptId: file.attemptId,
          status: status as "acknowledged" | "not_completed" | "unconfirmed" | "unsupported",
          ...(status === "unsupported" ? { failure: { method: "ui/download-file" as const, code: -32601 as const } } : {}) };
        await reportDownload();
      }
    }).finally(() => {
      if (downloadJob === job) { downloadJob = undefined; fileWork = false; }
      if (!disposed) { transport?.setFileTransferActive(!!downloadJob); render(); changed?.(); }
    });
  }
  function beginDownload(retry: boolean): void {
    if (!transport || !act || disposed || downloadJob || fileWork) return;
    const attemptId = crypto.randomUUID(), job = { attemptId, phase: "admitting" as "admitting" | "waiting" | "sending" };
    const input = retry && state.file && state.download
      ? { action: "settings_retry_download", operationId: state.operationId, fileId: state.file.fileId,
        previousAttemptId: state.download.currentAttemptId, attemptId }
      : { action: "settings_download_backup", operationId: state.operationId, attemptId };
    downloadJob = job; fileWork = true; downloadStatus = undefined; pendingReport = undefined; reportRecovery = undefined;
    render(); changed?.();
    if (retry) transport.setFileTransferActive(true);
    void transport.act(input, retry).then(() => {
      if (disposed || downloadJob !== job) return;
      job.phase = "waiting"; transport?.setFileTransferActive(true); render(); changed?.(); maybeDeliverDownload();
    }).catch(() => {
      if (downloadJob === job) { downloadJob = undefined; fileWork = false; }
      if (!disposed) { transport?.setFileTransferActive(false); render(); changed?.(); }
    });
  }
  function downloadControl(label: string, actionName: string, handler: () => void, blocked = false): HTMLButtonElement {
    const control = button(label, handler, "secondary"); control.dataset.cardAction = actionName;
    if (actionName !== "settings_download_backup") control.dataset.settingsFileAction = "true";
    if (blocked) control.dataset.settingsLocalBlocked = "true";
    control.disabled = blocked; return control;
  }
  function renderDownload(content: HTMLElement): void {
    const delivery = state.download;
    const file = state.draft?.kind === "download_backup" ? state.file : undefined;
    if (!renderLocalSave(content)) {
    const title = delivery?.endReason === "acknowledged" ? "Download requested" : delivery?.endReason === "cancelled" ? "Download cancelled"
      : delivery?.endReason ? "Download ended" : downloadJob ? delivery?.availability === "available" ? "Downloading backup…" : "Preparing backup…"
      : delivery?.hostReport === "not_completed" ? "Download not completed" : delivery?.hostReport === "unconfirmed" ? "Download unconfirmed" : "Backup ready";
    content.append(element("h2", undefined, title));
    if (delivery?.endReason === "acknowledged") content.append(element("p", "ui-note", "The app accepted the download request. This does not confirm that the file was saved or where it was saved."));
    else if (delivery?.endReason === "cancelled") content.append(element("p", "ui-note", "No further download will be sent from this request. This does not close a save dialog or delete a file already saved by the app."));
    else if (delivery?.endReason) content.append(element("p", "ui-note", delivery.endReason === "expired"
      ? "The time to download this backup has ended. Open a new Settings card to download the current records."
      : "This backup can no longer be downloaded. Open a new Settings card to try again."));
    else if (delivery?.hostReport === "not_completed") content.append(element("p", "ui-note", "The app did not complete the download request. It did not report whether it was cancelled, refused or failed."));
    else if (delivery?.hostReport === "unconfirmed" || delivery?.previousUnconfirmed ||
        !downloadJob && !pendingReport && delivery?.availability === "available" && !delivery.hostReport && downloadStatus !== "backup_unverified") {
      content.append(element("p", "ui-note", "The previous download could not be confirmed." +
        (act && delivery?.allowedFileActions.includes("settings_retry_download") ? " Retrying may save another copy if the app already handled it." : "")));
    }
    if (downloadStatus === "backup_unverified") content.append(element("p", "ui-note", "The backup could not be read or checked. Nothing was sent to the app for download."));
    if (file?.sealed) {
      content.append(row("Suggested file name", file.displayName), row("File size", `${file.totalSize.toLocaleString("en-US")} bytes`));
      if (file.totalSize > SETTINGS_IMPORT_MAX_SIZE) content.append(element("p", "ui-note", "This backup exceeds the 16 MiB restore limit."));
    }
    if (act && transport && delivery?.allowedFileActions.includes("settings_retry_download")) {
      content.append(downloadControl("Retry download", "settings_retry_download", () => beginDownload(true), !!downloadJob || !!pendingReport));
    }
    }
    if (act && transport && state.file && delivery?.allowedFileActions.includes("settings_cancel_download")) {
      content.append(downloadControl("Cancel download", "settings_cancel_download", () => {
        if (!transport || disposed || !state.file || !state.download) return;
        downloadJob = undefined; fileWork = false; downloadStatus = undefined;
        const input = { action: "settings_cancel_download", operationId: state.operationId, fileId: state.file.fileId, attemptId: state.download.currentAttemptId };
        transport.setFileTransferActive(true);
        void transport.act(input, true).catch(() => {}).finally(() => {
          if (!disposed) { transport?.setFileTransferActive(false); render(); changed?.(); }
        });
      }));
    }
    if (state.temporaryFileCleanup === "pending" || state.temporaryFileCleanup === "failed") {
      content.append(element("p", "ui-error", "Temporary-file cleanup has not been confirmed. Use Check status to check the same request."));
    }
    if (!act && delivery?.localSave?.status !== "saved") content.append(element("p", "ui-note", "To download a backup, ask in chat to open a new Settings card."));
    else if (delivery?.availability === "ended") content.append(element("p", "ui-note", "To download the current records again, ask in chat to open a new Settings card."));
  }
  function renderLocalSave(content: HTMLElement): boolean {
    const delivery = state.download, save = delivery?.localSave, file = state.file;
    if (!delivery || !save || (save.status !== "saved" && save.status !== "saving" && delivery.endReason && delivery.endReason !== "local_save_failed")) return false;
    content.append(element("h2", undefined, save.status === "saved" ? "Backup saved" : save.status === "saving" ? "Saving backup…"
      : save.status === "needs_consent" ? "Save a local copy?" : "Backup not saved"));
    if (save.status === "saved" && state.backupLocation) {
      const location = element("div", "settings-backup-location");
      location.append(row("Folder", element("span", "settings-path", state.backupLocation.directory)),
        row("File name", element("span", "settings-path", state.backupLocation.filename)));
      content.append(element("p", "ui-note", "The backup was saved in the Sui MCP backup folder on this computer."), location);
    } else if (save.status === "saving") content.append(element("p", "ui-note", "Wait while this backup is saved and checked. Use Check status to check the same request."));
    else if (save.status === "failed") content.append(element("p", "ui-error", save.failure === "target_conflict"
      ? "The backup location already contains an item or could not be verified. It has not been replaced."
      : save.failure === "not_published" ? "The backup could not be saved. You can retry saving the same backup."
      : "The backup could not be verified for saving. Open a new Settings card to try again."));
    if (save.status !== "saved" && save.status !== "saving" && delivery.previousUnconfirmed) {
      content.append(element("p", "ui-note", "An earlier request may already have saved this backup. Saving a local copy may leave another copy."));
    }
    if (file) {
      if (save.status !== "saved") content.append(row("Suggested file name", file.displayName));
      content.append(row("File size", `${file.totalSize.toLocaleString("en-US")} bytes`));
      if (file.totalSize > SETTINGS_IMPORT_MAX_SIZE) content.append(element("p", "ui-note", "This backup exceeds the 16 MiB restore limit."));
    }
    if (act && transport && delivery.allowedFileActions.includes("settings_store_backup")) {
      content.append(downloadControl(save.status === "needs_consent" ? "Save a local copy" : "Retry save", "settings_store_backup", () => {
        if (!transport || disposed || fileWork || !state.file || !state.download) return;
        const prior = state.download.localSave;
        const input = { action: "settings_store_backup", operationId: state.operationId, fileId: state.file.fileId,
          attemptId: state.download.currentAttemptId, saveAttemptId: crypto.randomUUID(), allowPossibleCopy: state.download.previousUnconfirmed,
          ...(prior?.currentSaveAttemptId ? { previousSaveAttemptId: prior.currentSaveAttemptId } : {}) };
        fileWork = true; transport.setFileTransferActive(true); render(); changed?.();
        void transport.act(input, true).catch(() => {}).finally(() => {
          fileWork = false; if (!disposed) { transport?.setFileTransferActive(false); render(); changed?.(); }
        });
      }, fileWork));
    }
    return true;
  }
  function details(content: HTMLElement, location: Page, impact: WalletRecoveryImpact | undefined, operation: SettingsDraft | undefined): void {
    const detail = accordion("Details");
    if (state.facts) detail.body.append(row("Version", state.facts.server.version));
    detail.body.append(row("Settings request ID", mono(state.operationId)));
    if (operation && operation.kind === state.draft?.kind && state.file) detail.body.append(row("File SHA-256", mono(state.file.sha256)));
    if (operation && ["export_local_data", "download_backup", "import_local_data", "reset_local_data"].includes(operation.kind)) {
      detail.body.append(element("p", "ui-note", "Local backups do not contain wallet keys, wallet connections, wallet approvals, access granted to cards, transaction bytes or signatures."));
    }
    if (operation?.kind === "import_local_data" && state.preparation?.preview) {
      const preview = object(state.preparation.preview);
      counts(detail.body, preview.currentCounts, "Checked local records");
      counts(detail.body, preview.incomingCounts, "Backup records");
      detail.body.append(row("Default address before restoring", typeof preview.currentReadAddress === "string" ? mono(preview.currentReadAddress) : "Not selected"),
        row("Default address in this backup", typeof preview.incomingReadAddress === "string" ? mono(preview.incomingReadAddress) : "Not selected"));
    }
    if (location === "advanced" && state.facts) for (const [endpoint, label, value] of [["grpc", "Sui node", state.facts.localSettings.suiGrpcUrl], ["graphql", "Activity data", state.facts.localSettings.suiGraphqlUrl]] as const) {
      if (operation && (operation.kind === "set_endpoint" || operation.kind === "restore_endpoint") && operation.endpoint !== endpoint) continue;
      detail.body.append(element("h3", undefined, label), row("Saved network address", value.storedValue), row("Network address in use", value.effectiveValue), row("Set by", sourceLabels[value.source]));
      if (value.pendingStoredValue) detail.body.append(row("Network address saved for next restart", value.pendingStoredValue));
    }
    if (impact) {
      detail.body.append(element("h3", undefined, "Connection and transaction request records"));
      if (typeof state.preparation?.walletRunId === "string") detail.body.append(row("Service run ID", mono(state.preparation.walletRunId)));
      for (const connection of impact.connections) {
        detail.body.append(row(`${connection.walletName ?? "Wallet"} connection ID`, mono(connection.connectionId)));
      }
      for (const request of impact.requests) {
        detail.body.append(row("Transaction request ID", mono(request.attempt_id)), row("Recorded request status", request.request_status));
      }
    }
    content.append(detail.details);
  }
  function render(preserveInputs = false) {
    const opened = node.querySelector<HTMLDetailsElement>("details")?.open === true;
    const inputValues = preserveInputs ? [...node.querySelectorAll<HTMLInputElement>("input")]
      .filter((item) => item.type !== "file").map((item) => item.value) : undefined;
    const content = section();
    const progress = commandProgress && currentSnapshot.state === "ready" && commandProgress.cardId === currentSnapshot.cardId &&
      commandProgress.operationId === state.operationId && (commandProgress.kind === "backup_check_response"
        ? state.draft?.kind === "import_local_data" && commandProgress.fileId === state.file?.fileId
        : JSON.stringify(commandProgress.draft) === JSON.stringify(state.draft)) ? commandProgress : undefined;
    const authoritativeOutcome = state.result || state.restoreCheck?.status === "can_restore" ||
      state.restoreCheck?.status === "cannot_restore" && ["invalid_backup", "file_unavailable", "input_unavailable"].includes(state.restoreCheck.reason);
    const checking = state.restoreCheck?.status === "checking" || !authoritativeOutcome &&
      (progress?.kind === "backup_check_response" || uploadJob?.progress?.stage === "checking");
    const busy = ["executing", "stopping", "starting"].includes(state.phase) || checking;
    const readyRestore = state.draft?.kind === "import_local_data" && state.restoreCheck?.status === "can_restore";
    // The displayed step owns both its content and its navigation. Stored
    // preparation can remain valid while restoration is temporarily blocked.
    const admittingDownload = downloadJob?.phase === "admitting";
    const step = admittingDownload ? "progress" : state.result ? "result" : busy ? "progress" : route.kind === "section" ? "section"
      : state.phase === "prepared" && (state.draft?.kind !== "import_local_data" || readyRestore) ? "confirmation" : "input";
    const page = route.kind === "section" ? route.page : pageFor(route.operation);
    const operation: SettingsDraft | undefined = admittingDownload ? { kind: "download_backup" } : step === "section" ? undefined : state.draft;
    const location = operation ? pageFor(operation.kind) : page;
    const impact = operation?.kind === "restart_wallet_service" && state.preparation?.impact
      ? walletRecoveryImpactSchema.parse(state.preparation.impact) : undefined;
    // Only a depth change slides. Status reads and file/progress updates stay
    // in place; animation never delays rendering, focus or action locking.
    const depth = step === "result" || step === "progress" ? displayedDepth ?? 2
      : step === "confirmation" ? 3 : step === "input" ? 2 : location === "overview" ? 0 : 1;
    content.classList.add("settings-page");
    if (displayedDepth !== undefined && depth !== displayedDepth) {
      content.classList.add(depth > displayedDepth ? "settings-page--forward" : "settings-page--back");
    }
    displayedDepth = depth;
    const toolbar = element("nav", "settings-toolbar"); toolbar.setAttribute("aria-label", "Settings navigation");
    node.dataset.settingsPage = location;
    if (step === "confirmation" && operation && act && state.allowedActions.includes("settings_back")) {
      const label = `Back to ${operationLabels[operation.kind]}`;
      const back = button(label, () => {
        if (disposed || fileWork) return;
        route = { kind: "operation", operation: operation.kind };
        act({ action: "settings_back", operationId: state.operationId });
      }, "secondary");
      back.dataset.cardAction = "settings_back";
      back.setAttribute("aria-label", label); back.classList.add("settings-back"); toolbar.append(back);
    } else if (step === "input" && operation && act) {
      const back = navigate(`Back to ${pageLabels[location]}`, { kind: "section", page: location }); back.classList.add("settings-back"); toolbar.append(back);
    } else if (step === "section" && location !== "overview") {
      const back = navigate("Back to Settings", { kind: "section", page: "overview" }); back.classList.add("settings-back"); toolbar.append(back);
    }
    const path = ["Settings", ...(location === "overview" ? [] : [pageLabels[location]]),
      ...(operation ? [operationLabels[operation.kind]] : []),
      ...(step === "result" ? ["Result"] : step === "progress" ? [operation?.kind === "download_backup" ? "Downloading" : checking ? "Checking backup" : "Applying change"]
        : step === "confirmation" ? ["Confirm"] : [])];
    const position = element("span", "settings-location", path.join(" / ")); position.setAttribute("aria-current", "page");
    toolbar.append(position); content.append(toolbar);
    if (operation?.kind === "download_backup") {
      renderDownload(content);
    } else if (step === "result" && state.result) {
      content.append(element("p", state.result.outcome === "failed" ? "ui-error" : "ui-note", state.result.message));
      const result = object(state.result.details);
      if (typeof result.storedValue === "string") {
        content.append(row(result.endpoint === "grpc" ? "Saved Sui node address (gRPC)" : "Saved activity data address (GraphQL)", result.storedValue));
        if (typeof result.effectiveValueAtSave === "string") content.append(row("Network address in use when saved", result.effectiveValueAtSave));
        content.append(element("p", "ui-note", result.effectiveSourceAtSave === "environment"
          ? "When this address was saved, the app launch settings specified the network address in use. If that setting is still present, restarting will keep using it. Remove that launch setting before restarting to use the saved address."
          : "The saved address is used after Sui MCP restarts, unless the app launch settings specify another address."), element("p", "ui-note", restartApps));
      }
      if (typeof result.path === "string") {
        if (state.backupLocation) {
          const location = element("div", "settings-backup-location");
          location.append(row("Folder", element("span", "settings-path", state.backupLocation.directory)),
            row("File name", element("span", "settings-path", state.backupLocation.filename)));
          content.append(location);
        }
        if (state.file) {
          content.append(row("File size", `${state.file.totalSize.toLocaleString("en-US")} bytes`));
          if (state.file.totalSize > SETTINGS_IMPORT_MAX_SIZE) content.append(element("p", "ui-note", "This backup exceeds the 16 MiB restore limit. The entire backup was saved, but this installation cannot restore a file this large."));
          if (act && transport) {
            const control = button("Download this backup", () => {
              if (disposed || !transport || !state.file || fileWork) return;
              fileWork = true; control.disabled = true;
              void downloadSettingsFile({ operationId: state.operationId, ...state.file }, transport, (status) => {
                downloadStatus = status; render(); changed?.();
              }, () => !disposed).finally(() => { fileWork = false; if (!disposed) { render(); changed?.(); } });
            }, "secondary");
            control.dataset.settingsDownload = "true"; control.disabled = fileWork;
            content.append(control);
          }
          if (downloadStatus) content.append(element("p", "ui-note", {
            pending: "Checking the backup before downloading…",
            backup_unverified: "The backup file could not be read or checked. Nothing was sent to the app for download. Check the folder shown above, or open a new Settings card to create another backup.",
            acknowledged: "The app received the download request. This does not confirm that the file was saved or where it was saved.",
            not_completed: "The app did not complete the download request. It did not report whether the download was cancelled, refused or failed. The file passed its check before the request.",
            unsupported: "This app cannot receive this file. The existing backup remains in the folder shown above.",
            unconfirmed: "The download could not be confirmed. You can try Download this backup again; the same file will be checked before it is sent."
          }[downloadStatus]));
        }
      }
      const cleanup = state.temporaryFileCleanup ?? state.file?.cleanup;
      if (cleanup === "failed" || cleanup === "pending") content.append(element("p", "ui-error", "Temporary-file cleanup has not been confirmed. The result above is unchanged. Use Check status to check again."));
      content.append(element("p", "ui-note", "To make another change, ask in chat to open a new Settings card."));
    } else if (step === "progress") {
      const progress = element("p", "ui-note", checking ? "Checking backup…" : state.phase === "stopping" ? "Stopping the wallet connection service…" : state.phase === "starting" ? "Starting the wallet connection service…" : "Finishing this change…");
      progress.setAttribute("role", "status"); content.append(progress);
      if (state.phase === "starting") content.append(element("p", "ui-note", "If the service is not responding, you can request another restart in a new Settings card under Troubleshooting. This card keeps the result of the current restart."));
    } else if (step === "confirmation" && state.draft) {
      content.append(element("h2", undefined, titles[state.draft.kind]));
      if (readyRestore && state.file) content.append(row("Backup file", state.file.displayName));
      if (state.draft.kind === "set_endpoint" || state.draft.kind === "restore_endpoint") {
        const target = object(state.preparation?.endpoint);
        content.append(row("Setting", state.draft.endpoint === "grpc" ? "Sui node (gRPC)" : "Activity data (GraphQL)"));
        if (typeof target.storedValue === "string") content.append(row("Previously saved network address", target.storedValue));
        if (typeof target.value === "string") content.append(row("Network address to save", target.value));
        content.append(element("p", "ui-note", "Sui MCP checks that this address connects to Sui mainnet before saving it. Fully quit and reopen all apps using Sui MCP to use the change. Restarting only the wallet connection service does not apply it."));
        if (target.source === "environment") content.append(element("p", "ui-note", "The app launch settings specify the network address to use. Restarting without removing that launch setting will keep using that address."));
      }
      if (state.draft.kind === "clear_read_address") content.append(element("p", "ui-note", "Clear the address used by default when viewing assets. This does not disconnect your wallet or cancel any transaction."));
      if (["export_local_data", "reset_local_data"].includes(state.draft.kind)) content.append(element("p", "ui-note", recordScope));
      if (state.draft.kind === "reset_local_data" || state.draft.kind === "import_local_data") {
        if (readyRestore) {
          content.append(element("p", "ui-error", "Restoring replaces local records and saved network settings, including records with unconfirmed transaction results. You cannot undo this from this card. Other open cards will no longer work; open new cards after restoring."),
            element("p", "ui-note", "Wallet keys and approvals are not restored. Transactions on Sui are not cancelled."));
        } else {
          content.append(element("p", "ui-error", "This deletes local records and saved settings, including records whose transaction results are still unconfirmed. It does not cancel transactions on Sui. Data cannot be replaced until pending wallet or transaction responses and the initial result-checking period have ended."));
          content.append(element("p", "ui-error", "You cannot undo this from this card. Other open cards will no longer work. You can still read this change's result."));
        }
        const preview = object(state.preparation?.preview);
        if (state.draft.kind === "import_local_data") {
          const before = object(preview.currentCounts), after = object(preview.incomingCounts);
          content.append(element("h3", undefined, "Records to replace (now → backup)"));
          for (const [key, label] of recordLabels) {
            if (typeof before[key!] === "number" && typeof after[key!] === "number" && (before[key!] !== 0 || after[key!] !== 0)) {
              content.append(row(label!, `${before[key!]} → ${after[key!]}`));
            }
          }
          if (typeof before.outcomeUnknownRequests === "number" && before.outcomeUnknownRequests > 0) {
            content.append(element("p", "ui-error", "The current records with unconfirmed transaction results will be removed."));
          }
          if (preview.activeAccountChange !== "unchanged") {
            content.append(row("Default address for viewing assets", preview.activeAccountChange === "cleared" ? "Will be cleared"
              : typeof preview.incomingReadAddress === "string" ? mono(preview.incomingReadAddress) : "Not selected"));
          }
          if (preview.restartRequiredAfterImport === true) content.append(element("p", "ui-note", "After restoring, fully quit and reopen all apps using Sui MCP. Network addresses specified in the app launch settings still take priority over the restored settings."));
          content.append(element("p", "ui-note", "Restoring a saved address does not reconnect your wallet. It can be used by default for viewing assets only when the same wallet connection is active and approves that address."));
        } else counts(content, state.preparation?.counts, "Current local records");
      }
      if (state.draft.kind === "restart_wallet_service") {
        content.append(element("p", "ui-note", "The wallet connection service restarts while your apps stay open. Pending wallet approvals can no longer send a transaction, and unfinished review checks stop. Transactions already sent to Sui are not cancelled; checks already in progress continue. Restarting does not confirm a failed disconnection or remove the connection from your wallet app."));
        const recorded = impact ?? walletRecoveryImpactSchema.parse(state.preparation?.impact);
        content.append(row("Wallet connection records", String(recorded.connections.length)),
          element("p", "ui-note", "These are recorded connections, not confirmation that a wallet is connected now. Restarting does not reconnect a disconnected wallet."));
        for (const connection of recorded.connections) {
          content.append(row("Wallet", connection.walletName ?? "Wallet"), row("Recorded status", connectionLabels[connection.status]));
          for (const address of connection.accounts) content.append(row("Recorded wallet address", mono(address)));
          if (connection.disconnectPending) content.append(element("p", "ui-note", "This wallet's disconnection has not been confirmed."));
        }
        const waiting = recorded.requests.filter((request) => request.request_status === "awaiting_signature").length;
        content.append(row("Wallet approval requests to stop", String(waiting)), row("Other transaction requests", String(recorded.requests.length - waiting)));
      }
      if (act && state.allowedActions.includes("settings_confirm")) content.append(operationActions(action(finalLabels[state.draft.kind], { action: "settings_confirm", operationId: state.operationId, preparationId: state.preparationId },
        ["reset_local_data", "import_local_data"].includes(state.draft.kind) ? "danger" : "primary")));
      else if (act) content.append(element("p", "ui-note", "This change cannot be confirmed right now."));
    } else if (operation) {
      let primary: HTMLElement | undefined;
      content.append(element("h2", undefined, operationLabels[operation.kind]));
      if (location === "records") content.append(element("p", "ui-note", recordScope));
      if (operation.kind === "import_local_data") {
        if (state.restoreCheck?.status === "cannot_restore") {
          const error = element("p", "ui-error", state.restoreCheck.message); error.setAttribute("role", "alert");
          content.append(element("h3", undefined, "Cannot restore"), error);
        } else if (state.restoreCheck?.status === "check_required") content.append(element("p", "ui-note", state.restoreCheck.message));
        if (uploadJob?.progress && !checking && !authoritativeOutcome) {
          const progress = element("p", "ui-note", uploadJob.progress.stage === "reading" ? "Reading the selected file…" : "Receiving backup…");
          progress.setAttribute("role", "status"); content.append(progress);
        }
        const picker = input({ type: "file" }); picker.accept = ".json,application/json"; picker.dataset.cardAction = "settings_begin_upload";
        picker.addEventListener("change", () => {
          const selected = picker.files?.[0]; if (!selected || !transport || fileWork || disposed) return;
          const job = { startingRevision: currentSnapshot.revision, progress: undefined as SettingsUploadProgress | undefined };
          uploadJob = job; fileWork = true; fileNotice = undefined;
          void uploadSettingsFile(selected, transport, () => ({ operationId: state.operationId, cardId: currentSnapshot.cardId }),
            () => !disposed && uploadJob === job, (progress) => {
              if (disposed || uploadJob !== job || progress.operationId !== state.operationId || progress.cardId !== currentSnapshot.cardId) return;
              job.progress = progress; render(); changed?.();
            })
            .then(() => { if (!disposed && uploadJob === job) fileNotice = undefined; })
            .catch((error: unknown) => {
              if (!disposed && uploadJob === job) fileNotice = { cardId: currentSnapshot.cardId, operationId: state.operationId, revision: currentSnapshot.revision,
                draft: JSON.stringify(state.draft), fileId: state.file?.fileId,
                message: error instanceof Error ? error.message : "The file transfer could not be confirmed. Choose the file again to continue." };
            })
            .finally(() => { if (uploadJob === job) uploadJob = undefined; fileWork = false; if (!disposed) { render(); changed?.(); } });
        });
        if (act && !state.file?.sealed) content.append(field(state.file ? "Choose the same file to continue" : "Choose a Sui MCP backup (up to 16 MiB)", picker));
        if (state.file) {
          content.append(row("Selected file", state.file.displayName), row("File received", `${state.file.receivedSize.toLocaleString("en-US")} / ${state.file.totalSize.toLocaleString("en-US")} bytes`));
          if (act && state.allowedActions.includes("settings_prepare")) {
            primary = action("Check backup again", { action: "settings_prepare", operationId: state.operationId }, "primary");
          }
          if (act) content.append(select("Change backup file", { kind: "import_local_data" }, false, true));
        }

      } else {
        if (operation.kind === "set_endpoint" || operation.kind === "restore_endpoint") {
          const value = operation.endpoint === "grpc" ? state.facts?.localSettings.suiGrpcUrl : state.facts?.localSettings.suiGraphqlUrl;
          content.append(row("Network setting", operation.endpoint === "grpc" ? "Sui node (gRPC)" : "Activity data (GraphQL)"));
          if (value) content.append(row("Current saved address", value.storedValue));
          if (operation.kind === "set_endpoint") content.append(row("Selected network address", operation.value));
          else content.append(element("p", "ui-note", "Review the built-in default address before confirming this change."));
          if (value?.source === "environment") content.append(element("p", "ui-note", "The app launch settings specify the network address in use. Saving or restoring an address here does not remove that launch setting."));
        } else if (operation.kind === "clear_read_address") {
          content.append(row("Default address for viewing assets", state.facts?.readAddress ? mono(state.facts.readAddress) : "Not selected"),
            element("p", "ui-note", "Clearing this default does not disconnect your wallet or change wallet approvals."));
        } else if (operation.kind === "restart_wallet_service") {
          if (state.facts) content.append(row("Wallet connection service", serviceLabels[state.facts.walletAvailability.status]));
          if (state.facts?.connectionReconciliationRequired) content.append(element("p", "ui-error", CONNECTION_RECONCILIATION_MESSAGE));
          if (state.facts && state.facts.walletAvailability.status !== "available") content.append(element("p", "ui-note", state.facts.walletAvailability.message));
          content.append(element("p", "ui-note", "Review the connection and transaction requests affected before confirming a service restart."));
        } else if (operation.kind === "export_local_data") {
          content.append(element("p", "ui-note", "Review the local records to save, then create the backup file."));
        } else if (operation.kind === "reset_local_data") {
          content.append(element("p", "ui-note", "Review the records and saved settings to delete before confirming the reset."));
        }
        if (act && state.allowedActions.includes("settings_prepare")) primary = action("Continue", { action: "settings_prepare", operationId: state.operationId }, "primary");
      }
      if (primary) content.append(operationActions(primary));
    } else {
      content.append(element("h2", undefined, page === "overview" ? "Choose a section" : pageLabels[page]));
      if (page === "overview") {
        content.append(element("p", "ui-note", "You can use the default Sui mainnet network settings. Custom settings are optional."));
        if (state.facts?.connectionReconciliationRequired) content.append(element("p", "ui-error", CONNECTION_RECONCILIATION_MESSAGE));
        const availability = state.facts?.walletAvailability;
        if (availability && availability.status !== "available") content.append(element("p", availability.status === "unavailable" ? "ui-error" : "ui-note",
          availability.message), ...(availability.status === "unavailable" ? [element("p", "ui-note", "Open Troubleshooting below to check the connection service.")] : []));
        const menu = element("div", "settings-menu"); menu.setAttribute("aria-label", "Settings sections");
        for (const target of ["address", "records", "troubleshooting", "advanced"] as const) {
          const item = navigate(pageLabels[target], { kind: "section", page: target }); item.classList.add("settings-menu-item"); item.setAttribute("aria-label", pageLabels[target]);
          item.textContent = "";
          item.append(element("span", "settings-menu-title", pageLabels[target]), element("span", "settings-menu-description", menuDescriptions[target]));
          menu.append(item);
        }
        content.append(menu);
        if (state.draft) {
          const pending = element("div", "settings-pending");
          pending.append(element("p", "ui-note", `Unfinished change: ${operationLabels[state.draft.kind]}.`),
            navigate("Resume", { kind: "operation", operation: state.draft.kind }));
          content.append(pending);
        }
      } else if (page === "address") {
        content.append(row("Default address for viewing assets", state.facts?.readAddress ? mono(state.facts.readAddress) : "Not selected"));
        if (state.facts?.assetReadAccount.status === "address_required" && state.facts.readAddress) content.append(element("p", "ui-note", "This saved address cannot currently be used by default. Provide an address in chat, or open Wallet connection and select an address approved by your connected wallet."));
        content.append(element("p", "ui-note", "The default address is used when you ask to view assets without naming an address. To connect or disconnect your wallet, or select an approved address, ask in chat to open Wallet connection. Clearing the default does not disconnect your wallet."));
        if (act && state.facts?.readAddress) content.append(select("Clear default address", { kind: "clear_read_address" }));
      } else if (page === "records") {
        content.append(element("p", "ui-note", recordScope));
        if (act) content.append(
          choice("Backup", "Download the current local records and Sui network settings as one backup file. If this connection cannot provide downloads, the same file is saved in the Sui MCP backup folder on this computer.", downloadControl("Download backup", "settings_download_backup", () => beginDownload(false))),
          choice("Restore", "Choose a Sui MCP backup. It will be checked automatically before you confirm the restore.", select("Restore local records", { kind: "import_local_data" })),
          choice("Reset", "Review the local records and stored settings to delete. This does not cancel transactions on Sui.", select("Reset local data", { kind: "reset_local_data" }, true)));
      } else if (page === "troubleshooting") {
        if (state.facts) {
          content.append(row("Wallet connection service", serviceLabels[state.facts.walletAvailability.status]));
          if (state.facts.connectionReconciliationRequired) content.append(element("p", "ui-error", CONNECTION_RECONCILIATION_MESSAGE));
          if (state.facts.observedAt) content.append(row("Status checked at", timeValue(state.facts.observedAt)));
          if (state.facts.walletAvailability.status !== "available") content.append(element("p", "ui-note", state.facts.walletAvailability.message));
        }
        content.append(element("p", "ui-note", "Restart the wallet connection service if a connection request is not responding. Starting up or waiting for you to approve in your wallet does not by itself mean a failure."));
        if (act) content.append(select("Restart connection service", { kind: "restart_wallet_service" }));
      } else if (page === "advanced" && state.facts) {
        for (const endpoint of ["grpc", "graphql"] as const) {
          const value = endpoint === "grpc" ? state.facts.localSettings.suiGrpcUrl : state.facts.localSettings.suiGraphqlUrl;
          const edit = input({ value: state.draft?.kind === "set_endpoint" && state.draft.endpoint === endpoint ? state.draft.value : value.storedValue }); edit.dataset.cardAction = "settings_select";
          const endpointForm = element("div", "settings-endpoint");
          endpointForm.append(field(endpoint === "grpc" ? "Sui node (gRPC)" : "Activity data (GraphQL)", edit), element("p", "ui-note", endpoint === "grpc"
            ? "Used to retrieve balances, check transactions before wallet approval and send approved transactions." : "Used to retrieve transaction activity."));
          if (act) {
            const prepare = button("Select network address", () => { if (!fileWork && !disposed) act({ action: "settings_select", draft: { kind: "set_endpoint", endpoint, value: edit.value } }); }, "secondary");
            prepare.dataset.cardAction = "settings_select";
            endpointForm.append(buttonRow(prepare, select("Select default network address", { kind: "restore_endpoint", endpoint })));
          }
          if (value.appliesAfter) endpointForm.append(element("p", "ui-note", "A saved change needs an app restart. " + restartApps));
          if (value.source === "environment") endpointForm.append(element("p", "ui-note", "The app launch settings specify the network address to use. Remove that launch setting before restarting to use an address saved here."));
          content.append(endpointForm);
        }
      }
      if (page !== "overview" && state.draft && page === pageFor(state.draft.kind)) {
        content.append(element("p", "ui-note", `Unfinished change: ${operationLabels[state.draft.kind]}.`),
          navigate("Resume", { kind: "operation", operation: state.draft.kind }));
      }
      if (act && page === "overview" && state.allowedActions.includes("settings_cancel")) {
        if (state.draft) content.append(element("p", "ui-note", "Closing Settings discards this unfinished change. Nothing will be applied."));
        content.append(endRow(action("Close Settings", { action: "settings_cancel" })));
      }
    }
    if (progress?.kind === "preparation_response" && !state.result && !busy) {
      const waiting = element("p", "ui-note", "Waiting for a response…"); waiting.setAttribute("role", "status"); content.append(waiting);
    }
    if (fileNotice && step === "input" && operation?.kind === "import_local_data") content.append(element("p", "ui-note", fileNotice.message));
    details(content, location, impact, operation); node.replaceChildren(content);
    if (inputValues) [...node.querySelectorAll<HTMLInputElement>("input")].filter((item) => item.type !== "file")
      .forEach((item, index) => { if (inputValues[index] !== undefined) item.value = inputValues[index]; });
    if (opened) node.querySelector<HTMLDetailsElement>("details")!.open = true;
  }
  render();
  return { node, update(next: CardSnapshot, nextContext: CardViewContext) {
    const data = settingsViewSchema.parse(next.data);
    if (data.operationId !== state.operationId) return false;
    if (pendingReport && data.file?.fileId === pendingReport.fileId && data.download?.currentAttemptId === pendingReport.attemptId &&
        data.download.hostReport === pendingReport.status) {
      pendingReport = undefined; reportRecovery = undefined;
    }
    if (pendingReport && (!data.download?.allowedFileActions.includes("settings_report_download") || data.file?.fileId !== pendingReport.fileId)) {
      pendingReport = undefined; reportRecovery = undefined;
    }
    // A stored input/progress revision also distinguishes an explicit same-kind
    // reselection before a file ID exists. Unchanged fact reads keep the error.
    if (fileNotice && (data.result || next.revision !== fileNotice.revision || next.cardId !== fileNotice.cardId || data.operationId !== fileNotice.operationId ||
        JSON.stringify(data.draft) !== fileNotice.draft || data.file?.fileId !== fileNotice.fileId)) fileNotice = undefined;
    const sameSnapshot = next === currentSnapshot;
    if (sameSnapshot && !commandProgress && !nextContext.settingsCommandProgress) return true;
    if (JSON.stringify(data.draft) !== JSON.stringify(state.draft)) route = data.draft
      ? { kind: "operation", operation: data.draft.kind } : { kind: "section", page: pageFor(state.draft?.kind) };
    const progress = uploadJob?.progress;
    if (uploadJob && (data.result || data.draft?.kind !== "import_local_data" ||
        progress?.stage === "reading" && next.revision > uploadJob.startingRevision ||
        progress?.fileId && data.file?.fileId !== progress.fileId ||
        progress?.sha256 && data.file && data.file.sha256 !== progress.sha256)) uploadJob = undefined;
    state = data; currentSnapshot = next; transport = nextContext.settings; changed = nextContext.onDisplayChange;
    commandProgress = nextContext.settingsCommandProgress;
    render(sameSnapshot); maybeDeliverDownload(); return true;
  }, displayRecovery() {
    return pendingReport ? reportRecovery : undefined;
  }, dispose() { disposed = true; uploadJob = undefined; fileNotice = undefined; downloadJob = undefined; pendingReport = undefined; } };
}
export const settingsRenderer = { title: "Settings", controls: (snapshot, act, _display, _wallet, context) => view(snapshot, act, context),
  result: (snapshot, _display, act, _wallet, context) => view(snapshot, act, context)
} satisfies CardRenderer;
