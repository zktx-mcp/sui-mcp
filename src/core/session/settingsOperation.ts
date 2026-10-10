import { z } from "zod";
import { assetReadAccountSchema, walletAvailabilitySchema } from "./walletConnection.js";
import { LOCAL_DATA_EXPORT_FORMAT } from "../activity/localDataTypes.js";
import { suiAddressStringSchema } from "../suiAddress.js";

// This is the existing backup input limit, measured before Base64/JSON wrapping.
export const SETTINGS_IMPORT_MAX_SIZE = 16 * 1024 * 1024;
const identity = z.string().uuid();
const size = z.number().int().nonnegative().safe();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const restoreCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_file") }).strict(),
  z.object({ status: z.literal("receiving") }).strict(),
  z.object({ status: z.literal("checking") }).strict(),
  z.object({ status: z.literal("check_required"), message: z.string().min(1) }).strict(),
  z.object({ status: z.literal("can_restore") }).strict(),
  z.object({ status: z.literal("cannot_restore"), reason: z.enum([
    "invalid_backup", "file_unavailable", "wallet_request_unsettled", "operation_busy", "input_unavailable", "check_failed"
  ]), message: z.string().min(1) }).strict()
]);
export type RestoreCheck = z.infer<typeof restoreCheckSchema>;
export const storedRestoreCheckSchema = z.object({ fileId: identity, sha256, totalSize: size, dataEpoch: size,
  userDataRevision: size, check: restoreCheckSchema }).strict();
export const settingsDraftSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_endpoint"), endpoint: z.enum(["grpc", "graphql"]), value: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("restore_endpoint"), endpoint: z.enum(["grpc", "graphql"]) }).strict(),
  z.object({ kind: z.enum(["clear_read_address", "export_local_data", "download_backup", "import_local_data", "reset_local_data", "restart_wallet_service"]) }).strict()
]);
export type SettingsDraft = z.infer<typeof settingsDraftSchema>;
export const settingsDownloadReportSchema = z.enum(["acknowledged", "not_completed", "unconfirmed", "unsupported"]);
export const settingsDownloadFailureSchema = z.object({ method: z.literal("ui/download-file"), code: z.literal(-32601) }).strict();
export const settingsDownloadEndSchema = z.enum(["acknowledged", "cancelled", "expired", "server_restarted", "data_replaced", "source_unavailable", "stored_locally", "local_save_failed"]);
export const settingsFileIdentitySchema = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict();
export type SettingsPhysicalFileIdentity = z.infer<typeof settingsFileIdentitySchema>;
const localSaveFailure = z.enum(["not_published", "target_conflict", "source_unavailable", "interrupted"]);
export type SettingsLocalSaveOutcome = { status: "saved" } | { status: "failed"; reason: z.infer<typeof localSaveFailure> };
const storedLocalSaveSchema = z.object({ status: z.enum(["needs_consent", "saving", "saved", "failed"]),
  attemptId: identity, fileId: identity, sha256, totalSize: size, destination: z.string(), ownerId: z.string().min(1),
  currentSaveAttemptId: identity.optional(),
  attempts: z.array(z.object({ saveAttemptId: identity, previousSaveAttemptId: identity.optional(),
    admittedAt: z.string().datetime(), allowPossibleCopy: z.boolean() }).strict()),
  sourceIdentity: settingsFileIdentitySchema.optional(), savedAt: z.string().datetime().optional(), failure: localSaveFailure.optional()
}).strict().superRefine((value, context) => {
  if (value.status === "needs_consent" ? value.attempts.length !== 0 || value.currentSaveAttemptId !== undefined :
      !value.currentSaveAttemptId || !value.attempts.some((a) => a.saveAttemptId === value.currentSaveAttemptId)) {
    context.addIssue({ code: "custom", message: "A local save must identify its admitted attempt." });
  }
  if (new Set(value.attempts.map((a) => a.saveAttemptId)).size !== value.attempts.length ||
      (value.status === "saved") !== (value.savedAt !== undefined) || value.status === "saved" && !value.sourceIdentity ||
      (value.status === "failed") !== (value.failure !== undefined)) {
    context.addIssue({ code: "custom", message: "Local save evidence must match its state." });
  }
});
export type SettingsLocalSave = z.infer<typeof storedLocalSaveSchema>;
export const storedSettingsDownloadSchema = z.object({
  currentAttemptId: identity,
  attempts: z.array(z.object({ attemptId: identity, admittedAt: z.string().datetime(), previousAttemptId: identity.optional(),
    hostReport: settingsDownloadReportSchema.optional(), failure: settingsDownloadFailureSchema.optional() }).strict()).min(1),
  readyAt: z.string().datetime().optional(), expiresAt: z.string().datetime().optional(), endReason: settingsDownloadEndSchema.optional(),
  localSave: storedLocalSaveSchema.optional()
}).strict().superRefine((value, context) => {
  if (new Set(value.attempts.map((attempt) => attempt.attemptId)).size !== value.attempts.length ||
      !value.attempts.some((attempt) => attempt.attemptId === value.currentAttemptId) ||
      (value.readyAt === undefined) !== (value.expiresAt === undefined)) {
    context.addIssue({ code: "custom", message: "Download attempts and lifetime must identify one stored snapshot." });
  }
  if (value.endReason === "stored_locally" && value.localSave?.status !== "saved" ||
      value.endReason === "local_save_failed" && value.localSave?.status !== "failed" ||
      value.attempts.some((a) => (a.hostReport === "unsupported") !== (a.failure !== undefined)) ||
      value.localSave && (value.localSave.attemptId !== value.currentAttemptId ||
        !value.attempts.some((a) => a.attemptId === value.currentAttemptId && a.hostReport === "unsupported") ||
        value.localSave.status === "saving" && value.endReason !== undefined ||
        (value.localSave.status === "saved") !== (value.endReason === "stored_locally"))) {
    context.addIssue({ code: "custom", message: "Local saving requires the current download's unsupported report." });
  }
});
export type SettingsDownload = z.infer<typeof storedSettingsDownloadSchema>;
export const settingsDownloadFileActionSchema = z.enum(["settings_retry_download", "settings_report_download", "settings_cancel_download", "settings_store_backup"]);
export const settingsActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings_download_backup"), operationId: identity, attemptId: identity }).strict(),
  z.object({ action: z.literal("settings_retry_download"), operationId: identity, fileId: identity,
    previousAttemptId: identity, attemptId: identity }).strict(),
  z.object({ action: z.literal("settings_report_download"), operationId: identity, fileId: identity,
    attemptId: identity, status: settingsDownloadReportSchema, failure: settingsDownloadFailureSchema.optional() }).strict().refine(
      (value) => (value.status === "unsupported") === (value.failure !== undefined), "Only unsupported downloads require the exact method failure."),
  z.object({ action: z.literal("settings_store_backup"), operationId: identity, fileId: identity, attemptId: identity,
    saveAttemptId: identity, previousSaveAttemptId: identity.optional(), allowPossibleCopy: z.boolean() }).strict(),
  z.object({ action: z.literal("settings_cancel_download"), operationId: identity, fileId: identity, attemptId: identity }).strict(),
  z.object({ action: z.literal("settings_select"), draft: settingsDraftSchema }).strict(),
  z.object({ action: z.literal("settings_prepare"), operationId: identity }).strict(),
  z.object({ action: z.literal("settings_begin_upload"), operationId: identity,
    name: z.string().min(1), totalSize: size.max(SETTINGS_IMPORT_MAX_SIZE), sha256 }).strict(),
  z.object({ action: z.literal("settings_upload_chunk"), operationId: identity, fileId: identity,
    offset: size.max(SETTINGS_IMPORT_MAX_SIZE), chunkBase64: z.string() }).strict(),
  z.object({ action: z.literal("settings_seal_upload"), operationId: identity, fileId: identity }).strict(),
  z.object({ action: z.literal("settings_confirm"), operationId: identity, preparationId: identity }).strict(),
  z.object({ action: z.literal("settings_back"), operationId: identity }).strict(),
  z.object({ action: z.literal("settings_cancel") }).strict()
]);
export type SettingsAction = z.infer<typeof settingsActionSchema>;
export type SettingsPhase = "draft" | "uploading" | "sealed" | "prepared" | "executing" | "stopping" | "starting" | "terminal";
export type SettingsResult = {
  outcome: "completed" | "failed" | "interrupted" | "superseded";
  recordedAt: string;
  message: string;
  details?: Record<string, unknown> | undefined;
  completionScope?: "backup_snapshot" | undefined;
};
export type SettingsOperation = {
  operationId: string; cardId: string; ownerId: string; dataEpoch: number;
  phase: SettingsPhase; draft?: SettingsDraft; preparationId?: string;
  fingerprint?: string; preparedUserDataRevision?: number;
  preparation?: Record<string, unknown>; fileId?: string;
  acceptedDigest?: string; admittedAt?: string; result?: SettingsResult;
  priorRunId?: string; nextRunId?: string;
  supersedesOperationId?: string; supersededByOperationId?: string;
  checkpoint?: "verify_export_after_owner_change";
};
export type SettingsFile = {
  fileId: string; operationId: string; role: "upload" | "export";
  relativePath: string; displayName: string; totalSize: number; receivedSize: number;
  sha256: string; sealed: boolean; invalidated: boolean;
  cleanup: "pending" | "complete" | "failed";
  cleanupOperationId?: string;
  reservation?: { offset: number; length: number; sha256: string };
};
export type SettingsView = z.infer<typeof settingsViewSchema>;

// A known rejection belongs to the selected complete file, not to the current
// local-data revision or short-lived confirmation. Selection/owner/epoch rules
// remain enforced by the operation's store and action handlers.
export function retainedBackupRejection(operation: SettingsOperation, file: SettingsFile | undefined) {
  const saved = storedRestoreCheckSchema.safeParse(operation.preparation?.restoreCheck);
  if (operation.draft?.kind !== "import_local_data" || !file || operation.fileId !== file.fileId ||
      file.operationId !== operation.operationId || file.role !== "upload" || file.invalidated || !file.sealed ||
      file.receivedSize !== file.totalSize || file.reservation || !saved.success ||
      saved.data.fileId !== file.fileId || saved.data.sha256 !== file.sha256 || saved.data.totalSize !== file.totalSize ||
      saved.data.dataEpoch !== operation.dataEpoch || saved.data.check.status !== "cannot_restore" ||
      saved.data.check.reason !== "invalid_backup") return undefined;
  return saved.data;
}

export function permitsBackupRecheck(check: RestoreCheck): boolean {
  return check.status === "check_required" || check.status === "cannot_restore" &&
    ["wallet_request_unsettled", "operation_busy", "check_failed"].includes(check.reason);
}

export class SettingsConflict extends Error {}

export const settingsResultSchema: z.ZodType<SettingsResult> = z.object({
  outcome: z.enum(["completed", "failed", "interrupted", "superseded"]), recordedAt: z.string().datetime(),
  message: z.string().min(1), details: z.record(z.string(), z.unknown()).optional(), completionScope: z.literal("backup_snapshot").optional()
}).strict();
const endpointView = z.object({ storedValue: z.string(), effectiveValue: z.string(),
  source: z.enum(["environment", "local_db", "builtin_default"]), pendingStoredValue: z.string().optional(),
  appliesAfter: z.literal("mcp_server_restart").optional() }).strict();
export const endpointPreparationSchema = z.object({ endpoint: z.enum(["grpc", "graphql"]),
  key: z.enum(["suiGrpcUrl", "suiGraphqlUrl"]), value: z.string().min(1), status: z.enum(["saved", "reset"]),
  storedValue: z.string(), effectiveValue: z.string(), source: endpointView.shape.source }).strict().refine((target) =>
    target.key === (target.endpoint === "grpc" ? "suiGrpcUrl" : "suiGraphqlUrl"), "The endpoint kind and preference key must agree.");
const count = z.number().int().nonnegative().safe();
const localDataCounts = z.object({ accounts: count, reviewSessions: count, reviewStateSnapshots: count, reviewStatusTransitions: count,
  reviewExecutions: count, reviewRequests: count, outcomeUnknownRequests: count, externalActivityScans: count,
  externalActivityTransactions: count, localSettings: count }).strict();
const importPreview = z.object({ status: z.literal("valid"), format: z.literal(LOCAL_DATA_EXPORT_FORMAT), network: z.literal("mainnet"),
  exportedAt: z.string().datetime(), currentCounts: localDataCounts, incomingCounts: localDataCounts, willReplace: z.literal(true),
  activeAccountChange: z.enum(["unchanged", "set", "cleared"]), currentReadAddress: suiAddressStringSchema.nullable(),
  incomingReadAddress: suiAddressStringSchema.nullable(), restartRequiredAfterImport: z.boolean() }).strict();
export const settingsViewSchema = z.object({
  kind: z.literal("settings"), operationId: identity,
  phase: z.enum(["draft", "uploading", "sealed", "prepared", "executing", "stopping", "starting", "terminal"]),
  draft: settingsDraftSchema.optional(), preparationId: identity.optional(), preparation: z.record(z.string(), z.unknown()).optional(),
  file: z.object({ fileId: identity, displayName: z.string(), totalSize: size, receivedSize: size, sha256,
    sealed: z.boolean(), cleanup: z.enum(["pending", "complete", "failed"]) }).strict().optional(),
  download: z.object({ availability: z.enum(["preparing", "available", "ended"]), currentAttemptId: identity,
    hostReport: settingsDownloadReportSchema.optional(), previousUnconfirmed: z.boolean(),
    endReason: settingsDownloadEndSchema.optional(), expiresAt: z.string().datetime().optional(), remainingMs: size.optional(),
    localSave: z.object({ status: z.enum(["needs_consent", "saving", "saved", "failed"]), currentSaveAttemptId: identity.optional(),
      failure: localSaveFailure.optional(), savedAt: z.string().datetime().optional() }).strict().optional(),
    allowedFileActions: z.array(settingsDownloadFileActionSchema) }).strict().optional(),
  restoreCheck: restoreCheckSchema.optional(),
  backupLocation: z.object({ directory: z.string().min(1), filename: z.string().min(1) }).strict().optional(),
  result: settingsResultSchema.optional(),
  temporaryFileCleanup: z.enum(["pending", "complete", "failed"]).optional(),
  priorRunId: identity.optional(), nextRunId: identity.optional(), supersedesOperationId: identity.optional(), supersededByOperationId: identity.optional(),
  allowedActions: z.array(z.enum(settingsActionSchema.options.map((option) => option.shape.action.value))), observe: z.boolean(),
  facts: z.object({ server: z.object({ name: z.string(), version: z.string(), network: z.literal("mainnet") }).strict(),
    localSettings: z.object({ suiGrpcUrl: endpointView, suiGraphqlUrl: endpointView }).strict(), readAddress: z.string().optional(),
    assetReadAccount: assetReadAccountSchema, walletAvailability: walletAvailabilitySchema,
    connectionReconciliationRequired: z.literal(true).optional(), observedAt: z.string().datetime().optional(),
    counts: localDataCounts }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.download && (value.draft?.kind !== "download_backup" || !value.file ||
      value.download.availability === "available" && (!value.file.sealed || !value.result || value.download.endReason || !value.download.expiresAt) ||
      value.download.availability === "ended" && !value.download.endReason)) {
    context.addIssue({ code: "custom", message: "Download delivery must describe its own snapshot and lifetime." });
  }
  if (value.draft?.kind === "download_backup" && value.preparation !== undefined) {
    context.addIssue({ code: "custom", message: "Private download preparation is not public preparation data." });
  }
  if (value.restoreCheck && (value.draft?.kind !== "import_local_data" || value.result)) {
    context.addIssue({ code: "custom", message: "Restore checks belong to an uncompleted import preparation." });
  }
  if (value.restoreCheck?.status === "can_restore" && (value.phase !== "prepared" || !value.file?.sealed || !value.allowedActions.includes("settings_confirm"))) {
    context.addIssue({ code: "custom", message: "Restore availability requires a sealed file and current confirmation." });
  }
  if (value.draft?.kind === "import_local_data" && value.restoreCheck?.status !== "can_restore" && value.allowedActions.includes("settings_confirm")) {
    context.addIssue({ code: "custom", message: "An unchecked or blocked import cannot offer confirmation." });
  }
  if (value.restoreCheck?.status === "receiving" && (!value.file || value.file.sealed || !["draft", "uploading"].includes(value.phase))) {
    context.addIssue({ code: "custom", message: "Receiving requires the selected unsealed upload." });
  }
  if (value.restoreCheck?.status === "check_required" && (!value.file?.sealed || value.phase !== "sealed")) {
    context.addIssue({ code: "custom", message: "A new check requires the same complete sealed upload." });
  }
  if (value.restoreCheck?.status === "cannot_restore" && value.restoreCheck.reason === "invalid_backup" &&
      (value.phase === "prepared" || value.allowedActions.includes("settings_prepare"))) {
    context.addIssue({ code: "custom", message: "A rejected backup requires an explicit new selection." });
  }
  if (value.backupLocation && !(value.result?.outcome === "completed" && (value.draft?.kind === "export_local_data" ||
      value.draft?.kind === "download_backup" && value.download?.localSave?.status === "saved" && value.download.endReason === "stored_locally"))) {
    context.addIssue({ code: "custom", message: "A backup location requires its recorded successful export." });
  }
  if (value.download?.localSave?.status === "saved" && !value.backupLocation) {
    context.addIssue({ code: "custom", message: "A saved backup must identify its verified location." });
  }
  if (value.draft?.kind === "export_local_data" && value.result?.outcome === "completed" &&
      typeof value.result.details?.path === "string" && !value.backupLocation) {
    context.addIssue({ code: "custom", message: "A recorded backup path must provide its folder and file name." });
  }
  if (value.temporaryFileCleanup && !value.result) context.addIssue({ code: "custom", message: "Cleanup of an applied or ended operation requires its recorded result." });
  if ((value.phase === "terminal") !== (value.result !== undefined) || value.phase === "terminal" && (value.observe || value.allowedActions.length)) {
    context.addIssue({ code: "custom", message: "A terminal Settings result cannot grant input or observation." });
  }
  if (value.phase === "prepared" && (!value.preparationId || !value.draft || !value.preparation)) context.addIssue({ code: "custom", message: "Settings confirmation requires a prepared identity and facts." });
  if (value.phase === "prepared" && value.draft?.kind === "import_local_data" && !importPreview.safeParse(value.preparation?.preview).success) {
    context.addIssue({ code: "custom", path: ["preparation", "preview"], message: "Import confirmation requires the validated current and incoming read context and record counts." });
  }
  if (value.phase === "prepared" && (value.draft?.kind === "set_endpoint" || value.draft?.kind === "restore_endpoint")) {
    const target = endpointPreparationSchema.safeParse(value.preparation?.endpoint);
    if (!target.success || target.data.endpoint !== value.draft.endpoint ||
        target.data.status !== (value.draft.kind === "set_endpoint" ? "saved" : "reset") ||
        value.draft.kind === "set_endpoint" && target.data.value !== value.draft.value) {
      context.addIssue({ code: "custom", path: ["preparation", "endpoint"], message: "Endpoint confirmation must name its exact prepared target." });
    }
  }
  if (value.file && value.file.receivedSize > value.file.totalSize) context.addIssue({ code: "custom", message: "Received content exceeds the selected file." });
});

export function settingsDownload(operation: SettingsOperation): SettingsDownload | undefined {
  if (operation.draft?.kind !== "download_backup") return undefined;
  const download = storedSettingsDownloadSchema.parse(operation.preparation?.download), save = download.localSave;
  if (save && (save.fileId !== operation.fileId || save.destination !== `backups/${operation.operationId}.json`)) {
    throw new SettingsConflict("The local save does not identify this request's backup.");
  }
  return download;
}
export type SettingsDownloadFileAction = Extract<SettingsAction, { action: z.infer<typeof settingsDownloadFileActionSchema> }>;
export function isSettingsDownloadFileAction(action: SettingsAction): action is SettingsDownloadFileAction {
  return settingsDownloadFileActionSchema.safeParse(action.action).success;
}
