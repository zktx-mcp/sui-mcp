import { SERVER_VERSION } from "../mcp/serverInfo.js";
import { z } from "zod";
import { suiAddressStringSchema } from "../core/suiAddress.js";
import { walletRunIdSchema, walletStartStageSchema, walletSnapshotSchema, walletSessionObservationSchema, walletSessionSchema, suiWalletRevisionSchema } from "../core/session/walletRuntime.js";
import { walletChainsSchema } from "../core/session/chainAccounts.js";
import { walletUnavailableReasonSchema } from "../core/session/walletConnection.js";

const envelope = z.object({ packageVersion: z.literal(SERVER_VERSION), runId: walletRunIdSchema });
const request = envelope.extend({ requestId: z.number().int().positive(), operationId: z.string().min(1) });
export const walletCommandSchema = z.union([
  envelope.extend({ type: z.literal("init"), dataDirectory: z.string().min(1), projectId: z.string().regex(/^[0-9a-f]{32}$/i),
    metadata: z.object({ name: z.string(), description: z.string(), url: z.string() }).strict() }).strict(),
  request.extend({ type: z.literal("connect"), chains: walletChainsSchema }).strict(),
  request.extend({ type: z.enum(["disconnect", "check_session"]), topic: z.string().min(1) }).strict(),
  request.extend({ type: z.literal("sign"), topic: z.string().min(1), account: suiAddressStringSchema,
    transactionBytesBase64: z.string().min(1), ...suiWalletRevisionSchema.shape }).strict()
]);
const reply = envelope.extend({ requestId: z.number().int().positive(), operationId: z.string().min(1) });
export const walletEventSchema = z.union([
  envelope.extend({ type: z.literal("stage"), stage: walletStartStageSchema }).strict(),
  envelope.extend({ type: z.literal("snapshot"), snapshot: walletSnapshotSchema, ready: z.boolean() }).strict(),
  envelope.extend({ type: z.literal("failure"), reason: walletUnavailableReasonSchema }).strict(),
  reply.extend({ type: z.literal("pairing"), uri: z.string().startsWith("wc:"), expiresAt: z.string().datetime() }).strict(),
  reply.extend({ type: z.literal("connected"), session: walletSessionSchema }).strict(),
  reply.extend({ type: z.literal("disconnected") }).strict(),
  reply.extend({ type: z.literal("checked"), observation: walletSessionObservationSchema, sequence: z.number().int().positive() }).strict(),
  reply.extend({ type: z.literal("signed"), transactionBytes: z.string().min(1), signature: z.string().min(1), ...suiWalletRevisionSchema.shape }).strict(),
  reply.extend({ type: z.literal("error"), code: z.enum(["rejected", "session_changed", "operation_failed"]) }).strict()
]);
export type WalletCommand = z.infer<typeof walletCommandSchema>;
export type WalletEvent = z.infer<typeof walletEventSchema>;
export type WalletInit = Extract<WalletCommand, { type: "init" }>;
