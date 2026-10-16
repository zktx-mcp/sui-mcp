import { z } from "zod";
import { walletChainResultsSchema, fixedChainAccount, walletChainSchema, walletChainsSchema, walletGrantsSchema, walletGrantAccount,
  walletGrantRevisionsSchema, SUI_MAINNET_WALLET_CHAIN, type WalletChainId, type WalletGrant } from "./chainAccounts.js";
import type { WalletSessionInspection } from "./walletRuntime.js";
import type { PendingWalletConnectionOperation } from "./walletConnectionOperations.js";
import { transactionRequestStatusSchema } from "./transactionRequest.js";

export { SUI_MAINNET_WALLET_CHAIN } from "./chainAccounts.js";
export const SUI_SIGN_TRANSACTION_METHOD = "sui_signTransaction" as const;
export const WALLET_CONNECTION_POLL_SECONDS = 5;
export const walletRunIdSchema = z.string().uuid();
export const walletStartStageSchema = z.enum(["process_start", "sdk_start", "session_restore", "state_sync"]);
export const walletUnavailableReasonSchema = z.enum([
  "initialization_failed", "restoration_failed", "wallet_state_unavailable"
]);
export type WalletUnavailableReason = z.infer<typeof walletUnavailableReasonSchema>;
export const walletAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), walletRunId: walletRunIdSchema }).strict(),
  z.object({ status: z.literal("initializing"), walletRunId: walletRunIdSchema, stage: walletStartStageSchema, message: z.string() }).strict(),
  z.object({ status: z.literal("recovering"), walletRunId: walletRunIdSchema, message: z.string() }).strict(),
  z.object({ status: z.literal("unavailable"), walletRunId: walletRunIdSchema.optional(), reason: walletUnavailableReasonSchema, message: z.string() }).strict()
]);
export type WalletAvailability = z.infer<typeof walletAvailabilitySchema>;
export function walletUnavailable(reason: WalletUnavailableReason, walletRunId?: string): Extract<WalletAvailability, { status: "unavailable" }> {
  const message = reason === "restoration_failed"
    ? "Wallet connections could not be restored."
    : reason === "wallet_state_unavailable"
      ? "The wallet connection status could not be checked. Saved transaction results remain available."
      : "The wallet connection service could not start.";
  return { status: "unavailable", reason, message, ...(walletRunId === undefined ? {} : { walletRunId }) };
}
export class WalletUnavailableError extends Error {
  constructor(readonly availability: Exclude<WalletAvailability, { status: "available" }>) { super(availability.message); }
}
export const workflowProgressSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }).strict(),
  z.object({ status: z.literal("waiting") }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.literal("wallet_unavailable"), message: z.string() }).strict()
]);
export type WorkflowProgress = z.infer<typeof workflowProgressSchema>;
export function workflowProgress(waiting: boolean, requiresWallet: boolean, availability: WalletAvailability): WorkflowProgress {
  if (!waiting) return { status: "idle" };
  if (requiresWallet && availability.status === "unavailable") {
    return { status: "unavailable", reason: "wallet_unavailable", message: availability.message };
  }
  return { status: "waiting" };
}
export const walletConnectionStatusSchema = z.enum([
  "awaiting_approval", "connected", "rejected", "failed", "expired", "stopped", "disconnected"
]);
// Recorded recovery facts, not proof of a currently usable wallet connection.
export const walletRecoveryImpactSchema = z.object({
  runId: z.string().uuid(),
  connections: z.array(z.object({ connectionId: z.string().min(1), revision: z.number().int().nonnegative(),
    status: walletConnectionStatusSchema, chainResults: walletChainResultsSchema, walletName: z.string().optional(),
    sdkPending: z.boolean(), disconnectPending: z.boolean() }).strict()),
  preparations: z.array(z.object({ id: z.string().min(1), revision: z.number().int().nonnegative(),
    review_revision: z.number().int().nonnegative(), preparation_id: z.string().nullable(), wallet_connection_id: z.string().nullable() }).strict()),
  requests: z.array(z.object({ attempt_id: z.string().min(1), revision: z.number().int().nonnegative(),
    request_status: transactionRequestStatusSchema, can_submit: z.number().int().min(0).max(1),
    sdk_pending: z.number().int().min(0).max(1), submit_pending: z.number().int().min(0).max(1), lookup_pending: z.number().int().min(0).max(1) }).strict())
}).strict();
export type WalletRecoveryImpact = z.infer<typeof walletRecoveryImpactSchema>;
export const walletConnectionSchema = z.object({
  connectionId: z.string().min(1), status: walletConnectionStatusSchema,
  revision: z.number().int().nonnegative(), requestedChains: walletChainsSchema,
  chainResults: walletChainResultsSchema, approvedAt: z.string().datetime().optional(),
  grants: walletGrantsSchema, grantRevisions: walletGrantRevisionsSchema,
  lifecycleRevision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  walletName: z.string().optional(), reason: z.string().optional()
}).strict().superRefine((connection, context) => {
  if (connection.chainResults.some((item) => !connection.requestedChains.includes(item.chainId)) ||
      connection.approvedAt && connection.chainResults.length !== connection.requestedChains.length ||
      !connection.approvedAt && connection.chainResults.length) {
    context.addIssue({ code: "custom", message: "Approval results must match the exact requested networks." });
  }
});
export type WalletConnection = z.infer<typeof walletConnectionSchema>;
export const connectionChainStateSchema = z.object({ chainId: walletChainSchema,
  status: z.enum(["available", "multiple_accounts", "not_approved", "invalid_response", "unavailable"]), address: z.string().optional(),
  suiSigningScopeApproved: z.boolean(), reason: z.string().optional() }).strict();
export type ConnectionView = WalletConnection & {
  sessionPresence?: "present" | "absent" | "unusable" | "unconfirmed";
  disconnectImpact?: { impactId: string; requestCount: number; chains: WalletChainId[] };
  chainStates?: z.infer<typeof connectionChainStateSchema>[] };
export const CONNECTION_RECONCILIATION_MESSAGE = "An unexpected wallet session is retained by the connection service. Remove it in your wallet app, then check status. Only one wallet connection can be used here.";
export const assetReadAccountSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), account: z.string() }).strict(),
  z.object({ status: z.literal("address_required"), reason: z.literal("read_address_cleared").optional() }).strict()
]);
export type AssetReadAccount = z.infer<typeof assetReadAccountSchema>;

// Recorded session identity and current-run facts; unknown is not absence.
export type WalletConnectionPresence = {
  confirmed: boolean; managed: boolean; dataCurrent: boolean; pending: boolean;
  hasRecordedSession: boolean; unrecorded: boolean;
  observation?: { status: "present" | "absent" | "unusable"; expiresAt?: string };
};
function connectionSessionPresence(connection: ConnectionView | undefined,
  presence: WalletConnectionPresence): NonNullable<ConnectionView["sessionPresence"]> {
  if (!presence.confirmed || !presence.managed) return "unconfirmed";
  if (presence.hasRecordedSession) return presence.observation?.status ?? "unconfirmed";
  // A settled attempt without approval has no session to inspect. Pending
  // responses or unrecorded SDK sessions cannot establish that absence.
  return !connection?.approvedAt && !presence.pending && !presence.unrecorded ? "absent" : "unconfirmed";
}
export function usableWalletConnection(connection: ConnectionView | undefined, at: number,
  presence: WalletConnectionPresence, connectionId: string, chainId: WalletChainId, address?: string): ConnectionView | undefined {
  if (!connection || connection.connectionId !== connectionId || !presence.hasRecordedSession || !presence.confirmed || !presence.managed ||
      !presence.dataCurrent || presence.pending || presence.observation?.status !== "present") return undefined;
  const fixed = fixedChainAccount(connection, chainId);
  return fixed && (address === undefined || address === fixed) && connection.status === "connected" &&
    Date.parse(connection.expiresAt) > at && Date.parse(presence.observation.expiresAt!) > at &&
    walletGrantAccount(connection.grants, chainId, fixed) ? connection : undefined;
}
export function walletConnectionEligibility(connection: ConnectionView | undefined, at: number,
  presence: WalletConnectionPresence, readAccount?: string, readAddressCleared = false) {
  const usable = connection && usableWalletConnection(connection, at, presence, connection.connectionId, SUI_MAINNET_WALLET_CHAIN);
  const sessionPresence = connectionSessionPresence(connection, presence);
  const manageable = !!(connection && !presence.pending && ["present", "unusable"].includes(sessionPresence));
  return { ...(presence.confirmed && presence.unrecorded ? { connectionReconciliationRequired: true as const } : {}),
    ...(usable ? { connection: usable } : {}), manageable,
    pairingAllowed: presence.confirmed && presence.managed && !presence.unrecorded && !presence.pending && sessionPresence === "absent",
    assetReadAccount: usable && readAccount && readAccount === fixedChainAccount(usable, SUI_MAINNET_WALLET_CHAIN) && !readAddressCleared ? { status: "available" as const, account: readAccount }
      : { status: "address_required" as const, ...(readAddressCleared ? { reason: "read_address_cleared" as const } : {}) } };
}
export function connectionHasSuiSigningScope(connection: WalletConnection, account: string): boolean {
  const grant = walletGrantAccount(connection.grants, SUI_MAINNET_WALLET_CHAIN, account);
  return fixedChainAccount(connection, SUI_MAINNET_WALLET_CHAIN) === account &&
    !!grant?.methods.includes(SUI_SIGN_TRANSACTION_METHOD) && ["accountsChanged", "chainChanged"].every((event) => grant.events.includes(event));
}
export function projectWalletConnection(connection: ConnectionView | undefined, at: number,
  presence: WalletConnectionPresence, available: boolean): ConnectionView | undefined {
  const sessionPresence = available ? connectionSessionPresence(connection, presence) : "unconfirmed";
  return connection && { ...connection, sessionPresence, chainStates: connection.chainResults.map((result) => {
    const address = result.status === "bound" ? result.address : undefined;
    const usable = !!(available && address && usableWalletConnection(connection, at, presence, connection.connectionId, result.chainId, address));
    return { chainId: result.chainId, status: result.status === "bound" ? usable ? "available" as const : "unavailable" as const : result.status,
      ...(address ? { address } : {}), suiSigningScopeApproved: result.chainId === SUI_MAINNET_WALLET_CHAIN && !!address && connectionHasSuiSigningScope(connection, address),
      ...(!usable ? { reason: sessionPresence === "absent" ? "The wallet session is no longer present. Connect again to use this network."
        : result.status === "multiple_accounts" ? "The wallet returned several addresses. Disconnect and connect again with one account for this network."
        : result.status === "not_approved" ? "The wallet did not approve this network."
          : result.status === "invalid_response" ? "The wallet returned invalid account information."
            : "This fixed address is not currently usable through this connection." } : {}) };
  }) };
}

export type WalletConnectionStatus = WalletConnection["status"];
export class WalletUserRejectedError extends Error {
  constructor() { super("The wallet request was rejected by the user."); }
}

// A private backend reference, never part of the model or card response.
export type WalletConnectionRecord = {
  connection: WalletConnection;
  ownerId: string;
  topic?: string;
  sdkPending: boolean;
  disconnectPending: boolean;
  pendingOperation?: PendingWalletConnectionOperation;
  runId?: string;
  current: boolean; dataEpoch: number; readAddressCleared: boolean;
};

// Shared recorded connection facts only. Each operation checks its own expiry,
// account, method and revision requirements at its decision boundary.
export function isOwnedConnectedWallet(record: WalletConnectionRecord | undefined, ownerId: string,
  disconnectPending: boolean): record is WalletConnectionRecord {
  return !!record && record.ownerId === ownerId && record.connection.status === "connected" && !disconnectPending;
}

export type WalletSession = {
  topic: string;
  grants: WalletGrant[];
  expiresAt: string;
  walletName?: string | undefined;
};

export interface WalletTransport {
  restore(): Promise<WalletSession[]>;
  connect(chains: readonly WalletChainId[]): Promise<{ uri: string; expiresAt: string; approval: Promise<WalletSession> }>;
  disconnect(topic: string): Promise<void>;
  sign(input: { topic: string; account: string; transactionBytesBase64: string }): Promise<{
    transactionBytes: string; signature: string;
  }>;
  onSessionChanged(listener: (topic: string, changedChains?: readonly WalletChainId[]) => void): () => void;
  session(topic: string): WalletSession | undefined;
  inspect(topic: string): WalletSessionInspection;
  inspectAll(): WalletSessionInspection[];
  stop(): void;
}
