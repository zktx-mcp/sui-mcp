import { receiptForCard } from "./receiptData.js";
import { receiptView } from "../../../review-app/src/ui/receiptView.js";
import { asRecord } from "../../../review-app/src/parse.js";
import { element, row, section, statusBanner } from "../../../review-app/src/ui/ui.js";
import type { CardRenderer } from "./lifecycle.js";

export const receiptRenderer = {
  title: "Transaction result",
  guidance: (_snapshot, context) => context.recoveryNeeded ? "Ask in chat for the result of this same transaction." : undefined,
  controls: () => element("p", "ui-note", "Please provide a transaction hash in chat."),
  result(snapshot, display) {
    const result = asRecord(snapshot.data);
    if (result?.status === "observed" && typeof result.txDigest === "string" && result.txDigest === snapshot.input.digest) {
      const status = asRecord(result.effectsStatus);
      if (typeof status?.success !== "boolean") throw new Error("Receipt outcome is unavailable.");
      const node = section("Transaction result");
      node.append(statusBanner(status.success ? "success" : "failure", status.success ? "Transaction succeeded" : "Transaction failed"),
        row("Transaction hash", result.txDigest), element("p", "ui-note", "Additional receipt details are unavailable."));
      return { node };
    }
    if (result?.status !== "found") {
      const message = result?.status === "not_found" ? "The transaction was not found." : "Transaction data is unavailable.";
      return { node: element("p", "ui-note", message) };
    }
    const receipt = receiptForCard(snapshot, display);
    return receiptView(receipt);
  }
} satisfies CardRenderer;
