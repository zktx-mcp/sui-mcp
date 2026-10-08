import { SERVER_VERSION } from "../mcp/serverInfo.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { walletUnavailable, WalletUnavailableError, WalletUserRejectedError, type WalletAvailability, type WalletSession,
  type WalletUnavailableReason } from "../core/session/walletConnection.js";
import { WalletRunInterruptedError, WalletReplacementFailedError, type WalletRuntime, type WalletRun, type WalletRuntimeEvent, type WalletSnapshot } from "../core/session/walletRuntime.js";
import { walletCommandSchema, walletEventSchema, type WalletCommand, type WalletEvent, type WalletInit } from "./walletSdkIpc.js";

type Reply = Extract<WalletEvent, { requestId: number }>;
type Pending = { operationId: string; type: WalletCommand["type"]; resolve(value: Reply): void; reject(error: Error): void;
  paired?: boolean; approve?: (session: WalletSession) => void; rejectApproval?: (error: Error) => void };
type Run = { id: string; child?: ChildProcess; fenced: boolean; serial: number; pending: Map<number, Pending>;
  exit: Promise<void>; didExit: boolean; end(): void; snapshot?: WalletSnapshot; initialized: boolean; sdkReady: boolean;
  termination?: Promise<void> | undefined };

/** Owns one SDK process. Business authority and all database transitions remain
 * in the workflow; a process event is never transaction approval. */
export class WalletSdkProcess implements WalletRuntime {
  private run = this.newRun();
  private state: WalletAvailability = this.starting(this.run.id, "process_start");
  private listener: ((event: WalletRuntimeEvent) => void) | undefined;
  private started = false;
  private closed = false;
  private replacement: { run: Run } | undefined;
  constructor(private readonly options: Omit<WalletInit, "type" | "runId" | "packageVersion" | "metadata"> & {
    metadata?: WalletInit["metadata"];
    spawn?: () => ChildProcess;
  }) {}
  private newRun(): Run {
    let end!: () => void;
    const exit = new Promise<void>((resolve) => { end = resolve; });
    return { id: randomUUID(), fenced: false, serial: 0, pending: new Map(), exit, end, didExit: false, initialized: false, sdkReady: false };
  }
  private starting(id: string, stage: Extract<WalletAvailability, { status: "initializing" }>["stage"]): WalletAvailability {
    return { status: "initializing", walletRunId: id, stage,
      message: stage === "session_restore" ? "Restoring wallet connections…" : "Starting the wallet connection service…" };
  }
  get runId(): string { return this.run.id; }
  availability(): WalletAvailability { return this.state; }
  snapshot(): WalletSnapshot | undefined { return this.run.snapshot; }
  synchronize(): void {
    const run = this.run;
    if (!this.closed && !run.fenced && run.sdkReady && !run.initialized && run.snapshot) {
      if (!this.emit({ type: "snapshot", runId: run.id, snapshot: run.snapshot, ready: true })) this.state = {
        status: "initializing", walletRunId: run.id, stage: "state_sync", message: "Wallet service state could not be saved. Check status to try again."
      };
    }
  }
  start(listener: (event: WalletRuntimeEvent) => void): void {
    if (this.started || this.closed) throw new Error("Wallet service already started or closed.");
    this.started = true; this.listener = listener; this.spawn(this.run);
  }
  private emit(event: WalletRuntimeEvent): boolean {
    if (this.closed) return false;
    try { this.listener?.(event); return true; }
    catch { return false; }
  }
  private failureReason(): WalletUnavailableReason {
    return this.state.status === "initializing" && this.state.stage !== "state_sync"
      ? this.state.stage === "session_restore" ? "restoration_failed" : "initialization_failed" : "wallet_state_unavailable";
  }
  private spawn(run: Run): void {
    if (this.closed || run !== this.run || run.fenced) return;
    try {
      if (!this.options.metadata) throw new Error("Wallet service metadata is unavailable.");
      const child = this.options.spawn?.() ?? fork(new URL("./walletSdkChild.js", import.meta.url), [], {
        execPath: process.execPath, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json"
      });
      run.child = child;
      child.on("message", (raw) => this.receive(run, raw));
      child.once("exit", () => this.exited(run));
      child.once("error", () => {
        this.lose(run, this.failureReason());
        // Failed spawn has no process and therefore cannot emit exit.
        if (child.pid === undefined) this.exited(run);
      });
      child.once("disconnect", () => { if (!run.fenced && !run.didExit) this.lose(run, this.failureReason()); });
      this.send(run, { packageVersion: SERVER_VERSION, runId: run.id, type: "init", dataDirectory: this.options.dataDirectory,
        projectId: this.options.projectId, metadata: this.options.metadata });
    } catch { this.lose(run, "initialization_failed"); if (!run.child) this.exited(run); }
  }
  private send(run: Run, message: WalletCommand): void {
    if (run !== this.run || run.fenced || this.closed || !run.child?.connected) throw new WalletRunInterruptedError(run.id);
    // A false return means backpressure, not permission to repeat the command.
    run.child.send(walletCommandSchema.parse(message), (error) => { if (error) this.lose(run, "wallet_state_unavailable"); });
  }
  private receive(run: Run, raw: unknown): void {
    if (this.closed || run !== this.run || run.fenced || run.didExit) return;
    const parsed = walletEventSchema.safeParse(raw);
    if (!parsed.success) { this.lose(run, "wallet_state_unavailable"); return; }
    const event = parsed.data;
    if (event.runId !== run.id) return;
    if (event.type === "failure") { this.lose(run, event.reason); return; }
    if (event.type === "stage") {
      if (run.initialized) { this.lose(run, "wallet_state_unavailable"); return; }
      this.state = this.starting(run.id, event.stage);
      if (!this.emit({ type: "stage", runId: run.id, stage: event.stage })) this.lose(run, "wallet_state_unavailable");
      return;
    }
    if (event.type === "snapshot") {
      if (event.snapshot.runId !== run.id) { this.lose(run, "wallet_state_unavailable"); return; }
      if (event.snapshot.sequence <= (run.snapshot?.sequence ?? 0)) return;
      if (event.ready && run.sdkReady || !event.ready && !run.sdkReady) { this.lose(run, "wallet_state_unavailable"); return; }
      const topics = new Set<string>();
      for (const session of event.snapshot.sessions) {
        if (topics.has(session.topic) || session.status === "present" && session.session.topic !== session.topic) {
          this.lose(run, "wallet_state_unavailable"); return;
        }
        topics.add(session.topic);
        const prior = run.snapshot?.sessions.find((entry) => entry.topic === session.topic);
        if (prior && (session.version < prior.version || session.version === prior.version && !isDeepStrictEqual(session, prior))) {
          this.lose(run, "wallet_state_unavailable"); return;
        }
      }
      const previous = run.snapshot;
      run.snapshot = event.snapshot;
      if (event.ready) { run.sdkReady = true; this.state = this.starting(run.id, "state_sync"); }
      const ready = run.sdkReady && !run.initialized;
      if (!this.emit({ type: "snapshot", runId: run.id, snapshot: event.snapshot, ...(previous ? { previous } : {}), ready })) {
        if (ready) this.state = { status: "initializing", walletRunId: run.id, stage: "state_sync", message: "Wallet service state could not be saved. Check status to try again." };
        else this.lose(run, "wallet_state_unavailable");
      }
      return;
    }
    const pending = run.pending.get(event.requestId);
    if (!pending || pending.operationId !== event.operationId) return;
    if (event.type === "error") {
      run.pending.delete(event.requestId);
      const error = event.code === "rejected" ? new WalletUserRejectedError() : new Error("The wallet operation could not be confirmed.");
      pending.reject(error); pending.rejectApproval?.(error); return;
    }
    if (event.type === "pairing" && pending.type === "connect" && !pending.paired) {
      pending.paired = true; pending.resolve(event); return;
    }
    if (event.type === "connected" && pending.type === "connect" && pending.paired) {
      run.pending.delete(event.requestId); pending.approve?.(event.session); return;
    }
    if (event.type === "disconnected" && pending.type === "disconnect" || event.type === "checked" && pending.type === "check_session" ||
        event.type === "signed" && pending.type === "sign") {
      run.pending.delete(event.requestId); pending.resolve(event); return;
    }
    this.lose(run, "wallet_state_unavailable");
  }
  publishReady(runId: string): void {
    const run = this.run;
    if (this.closed || run.id !== runId || run.fenced || !run.snapshot) throw new WalletRunInterruptedError(runId);
    run.initialized = true; this.state = { status: "available", walletRunId: run.id };
  }
  private lose(run: Run, reason: WalletUnavailableReason): void {
    if (run !== this.run || run.fenced || this.closed) return;
    run.fenced = true; this.state = walletUnavailable(reason, run.id);
    this.emit({ type: "lost", runId: run.id, reason });
    void this.terminate(run).catch(() => {});
  }
  fail(reason: WalletUnavailableReason): void { this.lose(this.run, reason); }
  block(reason: WalletUnavailableReason): void {
    this.run.fenced = true; this.state = walletUnavailable(reason, this.run.id);
  }
  fence(runId: string): void {
    if (this.closed || this.run.id !== runId || this.state.status === "recovering") throw new WalletRunInterruptedError(runId);
    this.run.fenced = true;
    this.state = { status: "recovering", walletRunId: runId, message: "Restarting the wallet connection service…" };
  }
  private terminate(run: Run): Promise<void> {
    if (run.termination) return run.termination;
    return run.termination = this.stopProcess(run).catch((error: unknown) => { run.termination = undefined; throw error; });
  }
  private async stopProcess(run: Run): Promise<void> {
    if (run.didExit) return;
    if (!run.child) { this.exited(run); return; }
    try {
      if (!run.child.kill("SIGKILL") && run.child.exitCode === null && run.child.signalCode === null) {
        if (run === this.run) this.state = walletUnavailable("wallet_state_unavailable", run.id);
        throw new Error("The wallet service process could not be stopped.");
      }
    } catch {
      if (run === this.run) this.state = walletUnavailable("wallet_state_unavailable", run.id);
      throw new Error("The wallet service process could not be stopped.");
    }
    await run.exit;
  }
  private exited(run: Run): void {
    if (run.didExit) return;
    if (!run.fenced && !this.closed) {
      run.fenced = true;
      const reason = this.failureReason();
      this.state = walletUnavailable(reason, run.id);
      this.emit({ type: "lost", runId: run.id, reason });
    }
    run.didExit = true;
    const error = new WalletRunInterruptedError(run.id);
    for (const pending of run.pending.values()) { pending.reject(error); pending.rejectApproval?.(error); }
    run.pending.clear();
    this.emit({ type: "exit", runId: run.id }); run.end();
  }
  async replace(runId: string, beforeStart: (nextRunId: string) => void): Promise<void> {
    const old = this.run;
    if (old.id !== runId || !old.fenced || this.closed) throw new WalletRunInterruptedError(runId);
    const replacement = { run: old }; this.replacement = replacement;
    try {
      await this.terminate(old);
      if (this.closed || this.run !== old || this.replacement !== replacement) throw new WalletRunInterruptedError(runId);
      const next = this.newRun();
      // A failed reservation ends this attempt. Reads may save its failure,
      // but only a new explicit admission may start another SDK process.
      beforeStart(next.id);
      this.run = next; this.state = this.starting(next.id, "process_start"); this.spawn(next);
    } catch {
      if (this.closed || this.run !== old || this.replacement !== replacement) throw new WalletRunInterruptedError(runId);
      this.state = walletUnavailable("wallet_state_unavailable", old.id);
      throw new WalletReplacementFailedError(old.id);
    } finally { if (this.replacement === replacement) this.replacement = undefined; }
  }
  dataReplaced(): void {
    this.replacement = undefined;
    const run = this.run;
    run.fenced = true; this.state = walletUnavailable("wallet_state_unavailable", run.id);
    void this.terminate(run).catch(() => {});
  }
  async close(): Promise<void> {
    if (this.closed) return this.run.exit;
    this.closed = true; this.replacement = undefined; this.run.fenced = true;
    await this.terminate(this.run);
  }
  bind(): WalletRun {
    const run = this.run;
    const assertCurrent = () => {
      if (run !== this.run || run.fenced || this.closed) throw new WalletRunInterruptedError(run.id);
      if (this.state.status !== "available") throw new WalletUnavailableError("wallet_state_unavailable", this.state.message);
    };
    assertCurrent();
    const call = (input: { type: "connect" } | { type: "disconnect" | "check_session"; topic: string } |
      { type: "sign"; topic: string; account: string; transactionBytesBase64: string; sessionVersion: number }, operationId: string,
      approval?: { approve(session: WalletSession): void; rejectApproval(error: Error): void }): Promise<Reply> => {
      assertCurrent();
      const requestId = ++run.serial;
      return new Promise<Reply>((resolve, reject) => {
        run.pending.set(requestId, { operationId, type: input.type, resolve, reject, ...approval });
        try { this.send(run, { ...input, packageVersion: SERVER_VERSION, runId: run.id, requestId, operationId }); }
        catch (error) { run.pending.delete(requestId); reject(error); }
      });
    };
    return { runId: run.id, assertCurrent,
      connect: async (operationId) => {
        let approve!: (session: WalletSession) => void, rejectApproval!: (error: Error) => void;
        const approval = new Promise<WalletSession>((resolve, reject) => { approve = resolve; rejectApproval = reject; });
        void approval.catch(() => {});
        const reply = await call({ type: "connect" }, operationId, { approve, rejectApproval });
        assertCurrent();
        if (reply.type !== "pairing") throw new Error("Wallet pairing response is unavailable.");
        return { uri: reply.uri, expiresAt: reply.expiresAt, approval };
      },
      disconnect: async (topic, operationId) => { await call({ type: "disconnect", topic }, operationId); assertCurrent(); },
      checkSession: async (topic, operationId) => {
        const reply = await call({ type: "check_session", topic }, operationId); assertCurrent();
        if (reply.type !== "checked" || reply.observation.topic !== topic || !run.snapshot || run.snapshot.sequence < reply.sequence ||
            run.snapshot.sessions.find((item) => item.topic === topic)?.version !== reply.observation.version) {
          throw new Error("The wallet session changed during confirmation.");
        }
        return reply.observation;
      },
      sign: async (input, operationId) => {
        const reply = await call({ ...input, type: "sign" }, operationId); assertCurrent();
        if (reply.type !== "signed") throw new Error("The wallet signature response is unavailable.");
        return { transactionBytes: reply.transactionBytes, signature: reply.signature, sessionVersion: reply.sessionVersion };
      }
    };
  }
}
