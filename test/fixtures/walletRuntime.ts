import { WALLET_CHAINS, type WalletChainId } from "../../src/core/session/chainAccounts.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { walletUnavailable, type WalletAvailability, type WalletTransport, type WalletUnavailableReason } from "../../src/core/session/walletConnection.js";
import { WalletRunInterruptedError, WalletReplacementFailedError, type WalletRuntime, type WalletRun, type WalletRuntimeEvent, type WalletSnapshot,
  type WalletSessionObservation } from "../../src/core/session/walletRuntime.js";

// External wallet-service double for SQLite/workflow tests. This does not prove
// child termination, SDK persistence, IPC ordering or relay behavior.
export class FixtureWalletRuntime implements WalletRuntime {
  runId = randomUUID();
  private state: WalletAvailability = { status: "initializing", walletRunId: this.runId, stage: "sdk_start", message: "Starting wallet service…" };
  private current: WalletSnapshot | undefined;
  private listener: ((event: WalletRuntimeEvent) => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private blocked = false;
  private closing = false;
  private exitHeld = false;
  private rejects = new Set<(error: Error) => void>();
  constructor(readonly transport?: WalletTransport) {}
  availability() { return this.state; }
  snapshot() { return this.current; }
  start(listener: (event: WalletRuntimeEvent) => void) { this.listener = listener; void this.initialize(); }
  private async initialize() {
    const runId = this.runId;
    if (!this.transport) { this.state = walletUnavailable("initialization_failed", this.runId); return; }
    try {
      await this.transport.restore();
      if (this.closing || this.blocked || this.runId !== runId) return;
      this.unsubscribe = this.transport.onSessionChanged((topic, changedChains) => {
        try { this.publish(false, topic, changedChains); } catch { this.fail("wallet_state_unavailable"); }
      });
      this.publish(true);
    } catch {
      if (!(this.state.status === "initializing" && this.state.stage === "state_sync")) this.state = walletUnavailable("restoration_failed", this.runId);
    }
  }
  private publish(ready: boolean, changed?: string, changedChains: readonly WalletChainId[] = [], checkTopic?: string) {
    const previous = this.current;
    const values = this.transport!.inspectAll();
    if (checkTopic && !values.some((item) => item.topic === checkTopic)) values.push(this.transport!.inspect(checkTopic));
    for (const old of previous?.sessions ?? []) if (!values.some((item) => item.topic === old.topic)) values.push({ topic: old.topic, status: "absent" });
    const sessions: WalletSessionObservation[] = values.map((value) => {
      const old = previous?.sessions.find((item) => item.topic === value.topic);
      const lifecycleChanged = !old || old.status !== value.status;
      const grantRevisions = { "sui:mainnet": 0, "eip155:1": 0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 0 };
      for (const chain of WALLET_CHAINS) {
        const before = old?.status === "present" ? old.session.grants.find((grant) => grant.chainId === chain) : undefined;
        const after = value.status === "present" ? value.session.grants.find((grant) => grant.chainId === chain) : undefined;
        grantRevisions[chain] = (old?.grantRevisions[chain] ?? 0) + Number(lifecycleChanged ||
          !isDeepStrictEqual(before, after) || changed === value.topic && changedChains.includes(chain));
      }
      return { ...value, lifecycleRevision: (old?.lifecycleRevision ?? 0) + Number(lifecycleChanged), grantRevisions };
    });
    this.current = { runId: this.runId, sequence: (previous?.sequence ?? 0) + 1, observedAt: new Date().toISOString(), sessions };
    if (ready) this.state = { status: "initializing", walletRunId: this.runId, stage: "state_sync", message: "Confirming wallet state…" };
    this.listener?.({ type: "snapshot", runId: this.runId, snapshot: this.current, ...(previous ? { previous } : {}), ready });
  }
  synchronize() {
    if (this.state.status === "initializing" && this.state.stage === "state_sync") this.publish(true);
  }
  publishReady(runId: string) {
    if (runId !== this.runId || this.blocked || this.closing) throw new WalletRunInterruptedError(runId);
    this.state = { status: "available", walletRunId: this.runId };
  }
  block(reason: WalletUnavailableReason) { this.blocked = true; this.state = walletUnavailable(reason, this.runId); }
  fence(runId: string) {
    if (runId !== this.runId) throw new WalletRunInterruptedError(runId);
    this.blocked = true; this.state = { status: "recovering", walletRunId: runId, message: "Restarting wallet service…" };
  }
  private interrupt() {
    for (const reject of this.rejects) reject(new WalletRunInterruptedError(this.runId));
    this.rejects.clear(); this.unsubscribe?.();
    if (!this.closing) { try { this.listener?.({ type: "exit", runId: this.runId }); } catch { /* Old data-generation events are discarded. */ } }
  }
  async replace(runId: string, beforeStart: (next: string) => void) {
    if (runId !== this.runId || !this.blocked || this.closing) throw new WalletRunInterruptedError(runId);
    this.interrupt();
    await Promise.resolve();
    if (this.closing || runId !== this.runId || this.state.status !== "recovering") throw new WalletRunInterruptedError(runId);
    const next = randomUUID();
    try { beforeStart(next); }
    catch { this.state = walletUnavailable("wallet_state_unavailable", runId); throw new WalletReplacementFailedError(runId); }
    this.runId = next; this.current = undefined; this.blocked = false;
    this.state = { status: "initializing", walletRunId: next, stage: "sdk_start", message: "Starting wallet service…" };
    void this.initialize();
  }
  fail(reason: WalletUnavailableReason) {
    this.block(reason);
    try { this.listener?.({ type: "lost", runId: this.runId, reason }); } catch { /* Storage failure cannot reopen this run. */ }
    if (!this.exitHeld) this.interrupt();
  }
  holdExit(): () => void { this.exitHeld = true; return () => { this.exitHeld = false; this.interrupt(); }; }
  dataReplaced() { this.block("wallet_state_unavailable"); this.interrupt(); }
  async close() { this.closing = true; this.blocked = true; this.unsubscribe?.(); this.transport?.stop(); this.interrupt(); }
  bind(): WalletRun {
    const runId = this.runId;
    const assertCurrent = () => {
      if (this.blocked || this.closing || runId !== this.runId || this.state.status !== "available") throw new WalletRunInterruptedError(runId);
    };
    assertCurrent();
    const wait = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      this.rejects.add(reject);
      void work.then((result) => {
        if (this.blocked || this.closing || runId !== this.runId) return;
        this.rejects.delete(reject); resolve(result);
      }, (error) => {
        if (this.blocked || this.closing || runId !== this.runId) return;
        this.rejects.delete(reject); reject(error);
      });
    });
    const check = (topic: string): WalletSessionObservation => {
      assertCurrent(); this.publish(false, undefined, [], topic);
      return this.current!.sessions.find((item) => item.topic === topic) ?? { topic, lifecycleRevision: 1, grantRevisions: { "sui:mainnet": 1, "eip155:1": 1, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 1 }, status: "absent" };
    };
    return { runId, assertCurrent,
      connect: async (chains) => {
        const pairing = await wait(this.transport!.connect(chains));
        return { ...pairing, approval: wait(pairing.approval).then((value) => { this.publish(false); return value; }) };
      },
      disconnect: async (topic) => { await wait(this.transport!.disconnect(topic)); this.publish(false); },
      checkSession: async (topic) => check(topic),
      sign: async ({ lifecycleRevision, grantRevision, chainId, ...input }) => {
        const before = check(input.topic);
        if (before.lifecycleRevision !== lifecycleRevision || before.grantRevisions[chainId] !== grantRevision) throw new Error("Fixture wallet grant changed before dispatch");
        const result = await wait(this.transport!.sign(input));
        const after = check(input.topic);
        return { ...result, chainId, lifecycleRevision: after.lifecycleRevision, grantRevision: after.grantRevisions[chainId] };
      }
    };
  }
}
