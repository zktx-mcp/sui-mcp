// Supplementary chain facts inside one disclosure, without nested disclosures.
import type { PublicChainReceipt, PublicChainReceiptEvent, PublicChainReceiptInput } from "../../../src/core/action/suiChainReceiptReader.js";
import type { SuiChainReceiptPackageCall } from "../../../src/core/action/suiChainReceiptEvidence.js";
import { section, detailItem, element, mono, placeholder, row, timeValue } from "./ui.js";
import { qualifiedName, shortHex, shortType, suiAmount, typeName } from "../format.js";
import { t } from "../i18n/i18n.js";

export function chainReceiptDetails(receipt: PublicChainReceipt): HTMLElement {
  const node = section();
  node.append(row("Transaction hash", mono(receipt.txDigest)), row(t.common.retrievedAt, timeValue(receipt.fetchedAt)));
  if (!receipt.effectsStatus.success && receipt.effectsStatus.errorMessage) node.append(row("Failure details", receipt.effectsStatus.errorMessage));
  node.append(element("h3", "ui-section-title", "Network fee breakdown"));
  node.append(element("p", "ui-note", t.receipt.netFeeExplanation));
  if (receipt.gas) for (const item of gasRows(receipt.gas)) node.append(item);
  if (receipt.gas?.budgetMist !== undefined) node.append(row(t.receipt.gasBudget, suiAmount(receipt.gas.budgetMist)), element("p", "ui-note", t.receipt.gasLimitExplanation));
  if (receipt.gas?.priceMist !== undefined) node.append(row(t.receipt.gasPrice, `${receipt.gas.priceMist} MIST`));
  if (receipt.gas?.paymentObjectId !== undefined) node.append(row(t.receipt.gasPayment, mono(receipt.gas.paymentObjectId)));
  if (receipt.balanceChanges.length) {
    const balances = section("Balance change records (raw units)");
    for (const change of receipt.balanceChanges) balances.append(detailItem({
      title: change.symbol ?? typeName(change.coinType), trailing: `${change.amountRaw} raw units`,
      metas: [{ label: t.receipt.account, value: change.address }, { value: change.coinType }]
    }));
    node.append(balances);
  }
  const missing = receipt.unavailableFields ?? [];
  if (!missing.includes("inputs")) node.append(inputsSection(receipt.inputs));
  if (!missing.includes("packageCalls")) node.append(moveCallsSection(receipt.packageCalls));
  if (!missing.includes("objectTypes")) node.append(objectChangesSection(receipt.objectTypes));
  if (!missing.includes("events")) node.append(eventsSection(receipt.events));
  if (missing.length) node.append(row("Unavailable receipt fields", missing.join(", ")));
  return node;
}

// Total is already in the primary summary; this disclosure shows components.
export function gasRows(gas: { computationMist: string; storageMist: string; storageRebateMist: string }): HTMLElement[] {
  return [row(t.receipt.gasComputation, suiAmount(gas.computationMist)),
    row(t.receipt.gasStorage, suiAmount(gas.storageMist)), row(t.receipt.gasRebate, suiAmount(gas.storageRebateMist))];
}

function inputsSection(inputs: PublicChainReceiptInput[]): HTMLElement {
  const body = section(`${t.receipt.inputs} (${inputs.length})`);
  if (inputs.length === 0) {
    body.append(placeholder(t.receipt.noInputs));
  } else {
    for (const inputEntry of inputs) {
      const metas: Array<{ label?: string; value: string; full?: string }> = [];
      if (inputEntry.objectId) {
        metas.push({ value: shortHex(inputEntry.objectId), full: inputEntry.objectId });
      }
      if (inputEntry.bytes) {
        metas.push({ label: t.receipt.bytes, value: shortHex(inputEntry.bytes), full: inputEntry.bytes });
      }
      body.append(detailItem({ title: t.receipt.inputKinds[inputEntry.kind], metas }));
    }
  }
  return body;
}

function moveCallsSection(calls: SuiChainReceiptPackageCall[]): HTMLElement {
  const body = section(`${t.receipt.moveCalls} (${calls.length})`);
  if (calls.length === 0) {
    body.append(placeholder(t.receipt.noMoveCalls));
  } else {
    for (const call of calls) {
      body.append(
        detailItem({ title: qualifiedName(call.target), metas: [{ value: shortType(call.target), full: call.target }] })
      );
    }
  }
  return body;
}

function objectChangesSection(objectTypes: Record<string, string>): HTMLElement {
  const entries = Object.entries(objectTypes);
  const body = section(`${t.receipt.objectChanges} (${entries.length})`);
  if (entries.length === 0) {
    body.append(placeholder(t.receipt.noObjectChanges));
  } else {
    for (const [objectId, objectType] of entries) {
      body.append(
        detailItem({
          title: typeName(objectType),
          metas: [
            { label: t.receipt.object, value: shortHex(objectId), full: objectId },
            { value: shortType(objectType), full: objectType }
          ]
        })
      );
    }
  }
  return body;
}

function eventsSection(events: PublicChainReceiptEvent[]): HTMLElement {
  const body = section(`${t.receipt.events} (${events.length})`);
  if (events.length === 0) {
    body.append(placeholder(t.receipt.noEvents));
  } else {
    for (const event of events) {
      body.append(
        detailItem({
          title: qualifiedName(event.eventType),
          metas: [{ value: shortType(event.eventType), full: event.eventType }]
        })
      );
    }
  }
  return body;
}
