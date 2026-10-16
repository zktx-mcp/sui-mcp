import { z } from "zod";
import { SUI_MAINNET_WALLET_CHAIN, walletRunIdSchema, walletStartStageSchema, type WalletAvailability, type WalletSession, type WalletTransport, type WalletUnavailableReason } from "./walletConnection.js";
import { walletGrantsSchema, walletGrantRevisionsSchema, type WalletChainId } from "./chainAccounts.js";

export { walletRunIdSchema, walletStartStageSchema } from "./walletConnection.js";
export type WalletStartStage = z.infer<typeof walletStartStageSchema>;
export const walletSessionSchema = z.object({
  topic: z.string().min(1), grants: walletGrantsSchema, expiresAt: z.string().datetime(), walletName: z.string().optional()
}).strict();
const observationIdentity = { topic: z.string().min(1), lifecycleRevision: z.number().int().positive(), grantRevisions: walletGrantRevisionsSchema };
export const walletSessionObservationSchema = z.discriminatedUnion("status", [
  z.object({ ...observationIdentity, status: z.literal("present"), session: walletSessionSchema }).strict(),
  z.object({ ...observationIdentity, status: z.enum(["absent", "unusable"]) }).strict()
]);
// Private session revisions fence stale responses; they are not a signature or card authorization.
export const suiWalletRevisionSchema = z.object({ chainId: z.literal(SUI_MAINNET_WALLET_CHAIN),
  lifecycleRevision: z.number().int().positive(), grantRevision: z.number().int().nonnegative() });
export type SuiWalletRevision = z.infer<typeof suiWalletRevisionSchema>;
export type WalletSigningInput = SuiWalletRevision & { topic: string; account: string; transactionBytesBase64: string };
export type WalletSessionObservation = z.infer<typeof walletSessionObservationSchema>;
export const walletObservationSchema = z.object({
  runId: walletRunIdSchema, sequence: z.number().int().positive(), observedAt: z.string().datetime()
}).strict();
export const walletSnapshotSchema = walletObservationSchema.extend({ sessions: z.array(walletSessionObservationSchema) }).strict();
export type WalletSnapshot = z.infer<typeof walletSnapshotSchema>;
export type WalletObservation = z.infer<typeof walletObservationSchema>;

export class WalletRunInterruptedError extends Error {
  constructor(readonly runId: string) { super("The wallet service run ended. This operation will not be repeated."); }
}
export class WalletReplacementFailedError extends Error {
  constructor(readonly runId: string) { super("The wallet service restart could not be confirmed."); }
}
export type WalletRuntimeEvent =
  | { type: "stage"; runId: string; stage: WalletStartStage }
  | { type: "snapshot"; runId: string; snapshot: WalletSnapshot; previous?: WalletSnapshot; ready: boolean }
  | { type: "lost"; runId: string; reason: WalletUnavailableReason }
  | { type: "exit"; runId: string };

// One captured SDK run. Methods never retarget themselves after recovery.
export interface WalletRun {
  readonly runId: string;
  assertCurrent(): void;
  connect(chains: readonly WalletChainId[], operationId: string): ReturnType<WalletTransport["connect"]>;
  disconnect(topic: string, operationId: string): Promise<void>;
  checkSession(topic: string, operationId: string, chainId?: WalletChainId): Promise<WalletSessionObservation>;
  sign(input: WalletSigningInput, operationId: string): Promise<SuiWalletRevision & { transactionBytes: string; signature: string }>;
}

export interface WalletRuntime {
  readonly runId: string;
  availability(): WalletAvailability;
  snapshot(): WalletSnapshot | undefined;
  synchronize(): void;
  start(listener: (event: WalletRuntimeEvent) => void): void;
  bind(): WalletRun;
  publishReady(runId: string): void;
  fence(runId: string): void;
  block(reason: WalletUnavailableReason): void;
  replace(runId: string, beforeStart: (nextRunId: string) => void): Promise<void>;
  fail(reason: WalletUnavailableReason): void;
  dataReplaced(): void;
  close(): Promise<void>;
}

// Low-level SDK inspection distinguishes invalid/expired sessions from a
// successful lookup proving absence. Source errors must be thrown.
export type WalletSessionInspection = { topic: string; status: "present"; session: WalletSession } |
  { topic: string; status: "absent" | "unusable" };
