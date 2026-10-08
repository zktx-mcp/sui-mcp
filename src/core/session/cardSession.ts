import { z } from "zod";

export const walletDisplaySchema = z.object({
  connectionId: z.string().min(1), pairingUri: z.string().startsWith("wc:"), expiresAt: z.string().datetime()
}).strict();
export type WalletDisplay = z.infer<typeof walletDisplaySchema>;


export const cardKindSchema = z.enum(["account", "receipt", "chart", "connect", "review", "settings"]);
export type CardKind = z.infer<typeof cardKindSchema>;
export const cardStateSchema = z.object({
  cardId: z.string().min(1), kind: cardKindSchema,
  state: z.enum(["ready", "running", "closed"]),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  input: z.record(z.string(), z.unknown()),
  data: z.unknown().optional(),
  reason: z.enum(["completed", "expired", "failed", "server_restarted", "cancelled"]).optional(),
  error: z.string().optional()
}).strict();
export type CardState = z.infer<typeof cardStateSchema>;
export const cardSnapshotSchema = cardStateSchema.extend({
  pollAfterMs: z.number().int().positive(),
  inputRemainingMs: z.number().int().nonnegative()
});
export type CardSnapshot = z.infer<typeof cardSnapshotSchema>;

// Private display values from a receipt already read by the backend. These are
// individual on-chain inputs, never a serialized transaction or a signature.
export const receiptDisplaySchema = z.object({
  // Sui syntax is validated by the backend producer/projection. The View checks
  // equality with its selected digest and does not load an SDK to recompute it.
  transactionDigest: z.string().min(1),
  pureInputs: z.array(z.object({
    index: z.number().int().nonnegative(),
    bytes: z.string().regex(/^0x(?:[0-9a-f]{2})*$/i)
  }).strict()).refine((items) => new Set(items.map((item) => item.index)).size === items.length, "Duplicate input index."),
  ptbGraph: z.object({ mermaid: z.object({ text: z.string(), namedText: z.string() }).strict() }).strict().optional()
}).strict();
export type ReceiptDisplay = z.infer<typeof receiptDisplaySchema>;
export type CardRecord = {
  state: CardState;
  tokenHash: string;
  ownerId: string;
  scope?: "read" | "connect" | "review" | "review_manage" | "settings";
  operationId?: string;
  acceptedInput?: Record<string, unknown>;
  receiptDisplay?: ReceiptDisplay;
};
export type CardResponse = {
  snapshot: CardSnapshot;
  receiptDisplay?: ReceiptDisplay;
  walletDisplay?: WalletDisplay;
  displayAttemptId?: string;
  error?: { code: "invalid_card_input" | "card_conflict" | "wallet_unavailable"; message: string };
};
export type CardReference = { cardId: string; permission: string };
export type CardSubmission = CardReference & { revision: number; input: Record<string, unknown> };

// Preparing choices does not admit a user's final selection. The store owns the
// persisted initial state; service adapters supply only data or a safe failure.
export type CardPreparation =
  | { status: "ready"; data?: unknown }
  | { status: "failed"; error: string };

export interface CardRecordStore {
  get(id: string): CardRecord | undefined;
  evaluate(expected: CardRecord, clock: () => Date): { record: CardRecord; evaluatedAt: string };
  admit(expected: CardRecord, input: Record<string, unknown>, ownerId: string, clock: () => Date): CardRecord | undefined;
  create(record: CardRecord): void;
  replace(expected: CardRecord, next: CardRecord): boolean;
  recover(ownerId: string, now: Date): void;
}
