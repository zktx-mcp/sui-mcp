import { TOOL_NAMES } from "../mcp/toolNames.js";
import { z } from "zod";
import { receiptDisplaySchema, walletDisplaySchema } from "../core/session/cardSession.js";

export { cardKindSchema, cardSnapshotSchema } from "../core/session/cardSession.js";
export type { CardKind, CardSnapshot, CardReference, CardSubmission } from "../core/session/cardSession.js";
export const CARD_RESOURCE_URIS = {
  account: "ui://sui-mcp/account.html",
  receipt: "ui://sui-mcp/receipt.html",
  chart: "ui://sui-mcp/chart.html",
  connect: "ui://sui-mcp/connect.html",
  disconnect: "ui://sui-mcp/disconnect.html",
  review: "ui://sui-mcp/review.html",
  settings: "ui://sui-mcp/settings.html"
} as const;
export const CARD_METADATA_KEY = "sui-mcp/card";
export const CARD_DISPLAY_METADATA_KEY = "sui-mcp/receipt-display";
export const WALLET_DISPLAY_METADATA_KEY = "sui-mcp/wallet-display";
export const SETTINGS_FILE_METADATA_KEY = "sui-mcp/settings-file";
export const CARD_RESOURCE_PREFIX = "suimcp://cards/";
export const cardInputRequiredSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), status: z.literal("input_required"), field: z.literal("account"), message: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("receipt"), status: z.literal("input_required"), field: z.literal("digest"), message: z.string().min(1) }).strict()
]);
export const cardReferenceSchema = z.object({ cardId: z.string().min(1), permission: z.string().min(1) }).strict();
export const cardReadReferenceSchema = cardReferenceSchema;
export const cardSubmissionSchema = cardReferenceSchema.extend({
  revision: z.number().int().nonnegative(), input: z.record(z.string(), z.unknown())
}).strict();
export const cardReceiptDisplaySchema = receiptDisplaySchema.extend({
  cardId: z.string().min(1), revision: z.number().int().nonnegative(), attemptId: z.string().min(1).optional()
});
export type CardReceiptDisplay = z.infer<typeof cardReceiptDisplaySchema>;
export const cardWalletDisplaySchema = walletDisplaySchema.extend({ cardId: z.string().min(1), revision: z.number().int().nonnegative() });
export type CardWalletDisplay = z.infer<typeof cardWalletDisplaySchema>;
export const settingsFileDisplaySchema = z.object({ attemptId: z.string().uuid(), cardId: z.string().min(1), operationId: z.string().uuid(), fileId: z.string().uuid(),
  offset: z.number().int().nonnegative().safe(), totalSize: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chunkBase64: z.string() }).strict();
export type SettingsFileDisplay = z.infer<typeof settingsFileDisplaySchema>;
export const CARD_TOOLS = {
  account: TOOL_NAMES.uiOpenAccount, receipt: TOOL_NAMES.uiOpenReceipt, chart: TOOL_NAMES.uiOpenChart,
  read: TOOL_NAMES.uiReadCard, submit: TOOL_NAMES.uiSubmitCard, act: TOOL_NAMES.uiActCard,
  readSettingsFile: TOOL_NAMES.uiReadSettingsFile
} as const;
