import { z } from "zod";
import { walletChainsSchema } from "./chainAccounts.js";
import { walletRunIdSchema } from "./walletConnection.js";

const operationId = z.string().uuid();
const command = { operationId, walletRunId: walletRunIdSchema };
export const walletConnectionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), ...command, chains: walletChainsSchema }).strict(),
  z.object({ action: z.literal("disconnect"), ...command, connectionId: z.string().min(1), impactId: z.string().min(1) }).strict()
]);
export type WalletConnectionAction = z.infer<typeof walletConnectionActionSchema>;
export const walletConnectionCardInputSchema = z.object({}).strict();
export const walletConnectionOperationSchema = z.object({
  operationId, cardId: z.string().min(1), action: z.enum(["connect", "disconnect"]),
  status: z.enum(["running", "completed", "failed", "stopped"]), connectionId: z.string().min(1),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  settlementPending: z.boolean(), message: z.string().optional(),
  endReason: z.enum(["user_stopped", "expired", "run_ended"]).optional()
}).strict();
export type WalletConnectionOperation = z.infer<typeof walletConnectionOperationSchema>;
export const pendingWalletConnectionOperationSchema = walletConnectionOperationSchema.pick({
  operationId: true, action: true, status: true, settlementPending: true
});
export type PendingWalletConnectionOperation = z.infer<typeof pendingWalletConnectionOperationSchema>;
export type WalletConnectionOperationRecord = WalletConnectionOperation & {
  ownerId: string; runId: string; dataEpoch: number; input: WalletConnectionAction;
};
export function publicConnectionOperation(record: WalletConnectionOperationRecord): WalletConnectionOperation {
  const { ownerId: _owner, runId: _run, dataEpoch: _epoch, input: _input, ...result } = record;
  return result;
}
