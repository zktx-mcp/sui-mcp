import { parseReceipt } from "../../../review-app/src/receiptFacts.js";
import { asRecord } from "../../../review-app/src/parse.js";
import type { CardSnapshot, CardReceiptDisplay } from "../contracts.js";

export function receiptForCard(snapshot: CardSnapshot, display?: CardReceiptDisplay) {
  const result = asRecord(snapshot.data);
  const receiptResult = snapshot.kind === "review" ? asRecord(result?.receipt) : result;
  const receipt = parseReceipt(receiptResult?.receipt);
  if (!receipt) throw new Error("Transaction data is incomplete.");
  if (display) {
    if (display.transactionDigest !== receipt.txDigest || display.cardId !== snapshot.cardId || display.revision !== snapshot.revision) {
      throw new Error("Receipt display details do not match this transaction.");
    }
    if (snapshot.kind === "review" && display.attemptId !== asRecord(result?.request)?.attemptId) throw new Error("Receipt details belong to a different request.");
    const inputs = new Map(receipt.inputs.map((item) => [item.index, item]));
    for (const value of display.pureInputs) {
      const input = inputs.get(value.index);
      if (!input || input.kind !== "pure") throw new Error("Receipt input details do not match this transaction.");
      input.bytes = value.bytes;
    }
    receipt.ptbGraph = display.ptbGraph;
  }
  return receipt;
}
