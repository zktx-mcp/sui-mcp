import { walletConnectionActionSchema } from "../src/core/session/walletConnectionOperations.js";
import { afterEach, expect, it, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";

const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
type Fixture = Awaited<ReturnType<typeof settingsWorkflowFixture>>;

// The block is an explicit SQLite unit-state input, not an observable gap
// between Settings admission and synchronous runtime fencing. Other wallet
// prerequisites remain valid so another denial cannot hide a missing guard.
async function ownBlock(f: Fixture, blocked: boolean) {
  const prepared = await f.prepare({ kind: "restart_wallet_service" });
  const data = prepared.snapshot.data as SettingsView;
  if (blocked) f.wallet.run(() => f.records.transaction(() => {
    const operation = f.records.get(data.operationId)!;
    f.records.admit(f.wallet.cardRecords.get(prepared.snapshot.cardId)!, {
      action: "settings_confirm", operationId: operation.operationId, preparationId: operation.preparationId!
    }, () => operation.fingerprint!);
    f.records.db.prepare("UPDATE settings_control SET wallet_input_blocked=1,wallet_block_operation_id=? WHERE id=1").run(operation.operationId);
  }));
  expect(f.wallet.run(() => f.records.control())).toMatchObject(blocked
    ? { wallet_input_blocked: 1, active_operation_id: data.operationId, wallet_block_operation_id: data.operationId }
    : { wallet_input_blocked: 0, active_operation_id: null, wallet_block_operation_id: null });
}
function state(f: Fixture) {
  return f.wallet.run(() => ({
    cards: f.records.db.prepare("SELECT id,revision,state,reason,operation_id,accepted_input_json FROM live_read_cards ORDER BY id").all(),
    operations: f.records.db.prepare("SELECT * FROM wallet_connection_operations ORDER BY operation_id").all(),
    connections: f.records.db.prepare("SELECT id,status,revision,run_id,connection_json FROM live_wallet_connections ORDER BY id").all(),
    reviews: f.records.db.prepare("SELECT id,revision,status,preparation_id FROM live_review_sessions ORDER BY id").all(),
    requests: f.records.db.prepare("SELECT attempt_id,revision,request_status FROM review_requests ORDER BY attempt_id").all(),
    authority: f.records.db.prepare("SELECT attempt_id,can_submit,sdk_pending,submit_pending,lookup_pending FROM live_request_authority ORDER BY attempt_id").all(),
    address: f.wallet.activity.getActiveAccountSync()
  }));
}

it.each(["connect", "disconnect_connected", "disconnect_failed", "prepare_review", "request_signature", "begin_submission"] as const)(
  "isolates the SQLite recovery block for an otherwise valid %s, with a normal positive control", async (action) => {
    for (const blocked of [false, true]) {
      const f = await settingsWorkflowFixture(); close.push(f.close);
      const w = f.wallet;
      let invoke: () => unknown;
      if (action === "connect") {
        const card = await w.createConnection();
        expect(card.snapshot.data).toMatchObject({ allowedActions: ["cancel", "connect"] });
        await ownBlock(f, blocked);
        invoke = () => w.records.admitConnection(w.cardRecords.get(card.snapshot.cardId)!, walletConnectionActionSchema.options[0].parse(w.connectionInput(card, { action: "connect" })));
      } else {
        const { connection } = await w.approve();
        if (action.startsWith("disconnect_")) {
          if (action === "disconnect_failed") {
            vi.mocked(w.transport.disconnect).mockRejectedValueOnce(new Error("Synthetic unconfirmed disconnect"));
            const prior = await w.run(() => w.cards.create("disconnect", {}));
            await w.act(prior, { action: "disconnect", connectionId: connection.connectionId });
            await vi.waitFor(() => expect(w.run(() => w.records.connection(connection.connectionId))).toMatchObject({ sdkPending: false, connection: { status: "failed" } }));
          }
          const card = await w.run(() => w.cards.create("disconnect", {}));
          expect(card.snapshot.data).toMatchObject({ allowedActions: ["cancel", "disconnect"] });
          await ownBlock(f, blocked);
          invoke = () => w.records.admitDisconnect(w.cardRecords.get(card.snapshot.cardId)!, walletConnectionActionSchema.options[1].parse(w.connectionInput(card, { action: "disconnect", connectionId: connection.connectionId })));
        } else if (action === "prepare_review") {
          const review = await w.run(() => w.sessions.createReviewSession([w.plan], w.now()));
          const card = await w.run(() => w.cards.create("review", w.reviewInput(review.session.id)));
          await ownBlock(f, blocked);
          invoke = () => w.records.beginReviewPreparation(w.cardRecords.get(card.snapshot.cardId)!, 0, connection, w.account);
        } else {
          const ready = await w.prepare(connection.connectionId);
          const material = await w.run(() => w.sessions.prepareReviewedTransaction(ready.session.id, w.plan.id, w.account, w.now()));
          const input = { action: "request_signature", connectionId: connection.connectionId, account: w.account, reviewRevision: ready.session.reviewRevision };
          if (action === "begin_submission") {
            const admitted = w.run(() => w.records.admitRequest(w.cardRecords.get(ready.card.snapshot.cardId)!, input, material, connection, w.runtime.runId));
            const bytes = w.run(() => w.activity.createTransactionMaterialStore().getTransactionMaterial(material.transactionMaterial, w.now())!.transactionBytes);
            const signed = await w.accountKey.signTransaction(bytes);
            expect(await Transaction.from(bytes).getDigest()).toBe(admitted.request.transactionDigest);
            await verifyTransactionSignature(bytes, signed.signature, { address: w.account });
            w.run(() => w.records.transitionRequest(admitted.request.attemptId, "awaiting_signature", w.now(), { signatureVerified: true }));
            await ownBlock(f, blocked);
            invoke = () => w.records.beginSubmission(admitted.request.attemptId);
          } else {
            await ownBlock(f, blocked);
            invoke = () => w.records.admitRequest(w.cardRecords.get(ready.card.snapshot.cardId)!, input, material, connection, w.runtime.runId);
          }
        }
      }
      const before = state(f);
      if (blocked) {
        if (action === "begin_submission") expect(w.run(invoke)).toBe(false);
        else expect(() => w.run(invoke)).toThrow("Wallet input is blocked while the connection service is being recovered.");
        expect(state(f)).toEqual(before);
        expect(w.run(() => f.records.control().wallet_input_blocked)).toBe(1);
      } else {
        const result = w.run(invoke);
        if (action === "begin_submission") expect(result).toBe(true);
        expect(state(f)).not.toEqual(before);
      }
      // Store primitives never dispatch SDK work. End-to-end recovery tests
      // separately verify that scoped rejected inputs dispatch nothing.
      expect(w.sign).not.toHaveBeenCalled(); expect(w.submit).not.toHaveBeenCalled();
    }
  });
