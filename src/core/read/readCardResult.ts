import { chartMarketBindingSchema } from "./chartMarketBinding.js";
import { suiChainReceiptEffectsStatusSchema } from "../action/suiChainReceiptEvidence.js";
import { z } from "zod";
import { assertNoForbiddenMcpFields } from "../action/forbiddenFields.js";
import { suiTransactionDigestSchema } from "../suiAddress.js";
import { receiptDisplaySchema, type CardKind, type ReceiptDisplay } from "../session/cardSession.js";

const receiptInput = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(["object", "shared_object", "receiving", "pure", "withdrawal", "unknown"]),
  objectId: z.string().optional(), bytes: z.string().optional()
}).strict();
const foundReceipt = z.object({ status: z.literal("found"), receipt: z.object({
  txDigest: suiTransactionDigestSchema,
  inputs: z.array(receiptInput).refine((items) => new Set(items.map((item) => item.index)).size === items.length),
  ptbGraph: receiptDisplaySchema.shape.ptbGraph
}).passthrough() }).strict();

// Partition the same source result before persistence. Never weaken the public
// forbidden-field check or turn arbitrary fields into private metadata.
export function projectReadCardResult(kind: CardKind, input: Record<string, unknown>, source: unknown): {
  data: unknown; receiptDisplay?: ReceiptDisplay;
} {
  if (kind === "chart" && source && typeof source === "object" && "status" in source &&
      (source.status === "ok" || source.status === "empty_result" || source.status === "partial_coverage" || source.status === "preview")) {
    const result = chartMarketBindingSchema.parse(source);
    if (input.poolId && input.poolId !== result.pair.poolId || input.poolName && result.source.endpoint === "ohclv" && input.poolName !== result.source.poolName) throw new Error("Chart market identity mismatch.");
  }
  if (kind === "receipt" && source && typeof source === "object" && "status" in source && source.status === "observed") {
    const minimal = z.object({ status: z.literal("observed"), txDigest: suiTransactionDigestSchema, effectsStatus: suiChainReceiptEffectsStatusSchema,
      fetchedAt: z.iso.datetime(), detailStatus: z.literal("unavailable") }).strict().parse(source);
    if (minimal.txDigest !== input.digest) throw new Error("Observed outcome differs from the requested transaction.");
    return { data: minimal };
  }
  if (kind !== "receipt" || !source || typeof source !== "object" || !("status" in source) || source.status !== "found") {
    assertNoForbiddenMcpFields(source);
    return { data: source };
  }
  const result = foundReceipt.parse(source);
  if (result.receipt.txDigest !== input.digest) throw new Error("Receipt digest differs from the selected transaction.");
  const { inputs, ptbGraph, ...facts } = result.receipt;
  const pureInputs: ReceiptDisplay["pureInputs"] = [];
  const publicInputs = inputs.map(({ bytes, ...item }) => {
    if (bytes !== undefined) {
      if (item.kind !== "pure") throw new Error("Only a Pure input may contain a display value.");
      pureInputs.push({ index: item.index, bytes });
    }
    return item;
  });
  const receiptDisplay = receiptDisplaySchema.parse({ transactionDigest: facts.txDigest, pureInputs, ptbGraph });
  const data = { status: "found", receipt: { ...facts, inputs: publicInputs },
    uiDetails: { inputValues: "ui_only", ptbGraph: "ui_only" } };
  assertNoForbiddenMcpFields(data);
  return { data, receiptDisplay };
}
