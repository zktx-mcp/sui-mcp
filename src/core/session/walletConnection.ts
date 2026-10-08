import { z } from "zod";
import { suiAddressStringSchema } from "../suiAddress.js";
import type { WalletSessionInspection } from "./walletRuntime.js";
import { transactionRequestStatusSchema } from "./transactionRequest.js";

export const SUI_MAINNET_WALLET_CHAIN = "sui:mainnet" as const;
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
  constructor(readonly reason: WalletUnavailableReason, message = walletUnavailable(reason).message) { super(message); }
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
    status: walletConnectionStatusSchema, accounts: z.array(suiAddressStringSchema), walletName: z.string().optional(),
    sdkPending: z.boolean(), disconnectPending: z.boolean() }).strict()),
  preparations: z.array(z.object({ id: z.string().min(1), revision: z.number().int().nonnegative(),
    review_revision: z.number().int().nonnegative(), preparation_id: z.string().nullable(), wallet_connection_id: z.string().nullable() }).strict()),
  requests: z.array(z.object({ attempt_id: z.string().min(1), revision: z.number().int().nonnegative(),
    request_status: transactionRequestStatusSchema, can_submit: z.number().int().min(0).max(1),
    sdk_pending: z.number().int().min(0).max(1), submit_pending: z.number().int().min(0).max(1), lookup_pending: z.number().int().min(0).max(1) }).strict())
}).strict();
export type WalletRecoveryImpact = z.infer<typeof walletRecoveryImpactSchema>;
export const walletConnectionSchema = z.object({
  connectionId: z.string().min(1),
  status: walletConnectionStatusSchema,
  revision: z.number().int().nonnegative(),
  accounts: z.array(suiAddressStringSchema),
  methods: z.array(z.string()),
  chain: z.literal(SUI_MAINNET_WALLET_CHAIN),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  walletName: z.string().optional(),
  reason: z.string().optional()
}).strict();
export type WalletConnection = z.infer<typeof walletConnectionSchema>;
export type ConnectionView = WalletConnection & { pendingAction?: "disconnect" };
export const connectionConflictSchema = z.object({
  reason: z.literal("multiple_connections"),
  connectionIds: z.array(z.string().min(1)).min(2).refine((ids) => new Set(ids).size === ids.length)
}).strict();
export type ConnectionConflict = z.infer<typeof connectionConflictSchema>;
export const CONNECTION_CONFLICT_MESSAGE = "More than one wallet connection is saved. Disconnect the connections you no longer need before continuing.";
export const CONNECTION_RECONCILIATION_MESSAGE = "A wallet connection in the connection service is not recorded here. Remove the retained connection in your wallet app, then check its status. If needed, open Settings and use Troubleshooting to restart the connection service and inspect it again. Restarting does not approve an unrecorded connection.";
export type StoredReadAccount = { address: string; walletId?: string | undefined };
export const assetReadAccountSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), account: suiAddressStringSchema }).strict(),
  z.object({ status: z.literal("address_required") }).strict()
]);
export type AssetReadAccount = z.infer<typeof assetReadAccountSchema>;

// Private facts from the current SDK run, joined to the journal by topic.
// Unknown inspection is not evidence of an empty connection service.
export type WalletConnectionPresence = {
  confirmed: boolean; connections: { connectionId: string; expiresAt: string }[]; unrecorded: boolean; pendingConnectionIds: string[];
};
export function walletConnectionSelection(connections: readonly ConnectionView[], at: number,
  presence: WalletConnectionPresence, stored?: StoredReadAccount): {
  connection?: ConnectionView; conflict?: ConnectionConflict; pairingAllowed: boolean; assetReadAccount: AssetReadAccount;
  manageableConnectionIds: string[]; connectionReconciliationRequired?: true;
} {
  const connected = connections.filter((item) => item.status === "connected" && Date.parse(item.expiresAt) > at);
  const pending = presence.pendingConnectionIds.length > 0 || connections.some((item) => item.pendingAction || item.status === "awaiting_approval");
  const presentIds = presence.connections.map((item) => item.connectionId);
  const occupied = new Set([...connected.map((item) => item.connectionId), ...presentIds]);
  const reconciliation = presence.confirmed && presence.unrecorded && !pending;
  const connection = presence.confirmed && !presence.unrecorded && occupied.size === 1 && connected.length === 1 &&
    presence.connections.some((item) => item.connectionId === connected[0]!.connectionId && Date.parse(item.expiresAt) > at) && !pending ? connected[0] : undefined;
  return {
    ...(occupied.size > 1 ? { conflict: { reason: "multiple_connections" as const,
      connectionIds: [...occupied].sort() } } : {}),
    ...(reconciliation ? { connectionReconciliationRequired: true as const } : {}),
    manageableConnectionIds: connections.filter((item) => !presence.pendingConnectionIds.includes(item.connectionId) && !item.pendingAction && item.status !== "awaiting_approval" &&
      (item.status === "connected" || presence.confirmed && presentIds.includes(item.connectionId))).map((item) => item.connectionId),
    ...(connection ? { connection } : {}),
    pairingAllowed: presence.confirmed && !presence.unrecorded && occupied.size === 0 && !pending,
    assetReadAccount: connection && stored?.walletId === connection.connectionId && connection.accounts.includes(stored.address)
      ? { status: "available", account: stored.address } : { status: "address_required" }
  };
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
  runId?: string;
};

// Shared recorded connection facts only. Each operation checks its own expiry,
// account, method and revision requirements at its decision boundary.
export function isOwnedConnectedWallet(record: WalletConnectionRecord | undefined, ownerId: string,
  disconnectPending: boolean): record is WalletConnectionRecord {
  return !!record && record.ownerId === ownerId && record.connection.status === "connected" && !disconnectPending;
}

export type WalletSession = {
  topic: string;
  accounts: string[];
  methods: string[];
  chain: typeof SUI_MAINNET_WALLET_CHAIN;
  expiresAt: string;
  walletName?: string | undefined;
};

export interface WalletTransport {
  restore(): Promise<WalletSession[]>;
  connect(): Promise<{ uri: string; expiresAt: string; approval: Promise<WalletSession> }>;
  disconnect(topic: string): Promise<void>;
  sign(input: { topic: string; account: string; transactionBytesBase64: string }): Promise<{
    transactionBytes: string; signature: string;
  }>;
  onSessionChanged(listener: (topic: string, selectionChanged?: boolean) => void): () => void;
  session(topic: string): WalletSession | undefined;
  inspect(topic: string): WalletSessionInspection;
  inspectAll(): WalletSessionInspection[];
  stop(): void;
}
