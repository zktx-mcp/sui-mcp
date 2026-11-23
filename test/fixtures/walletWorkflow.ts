import { verifyInstalledMinimum } from "../../src/adapters/reviewAdapters.js";
import { isFixtureSharedObject } from "./transactionMaterial.js";
import type { DeepbookSwapReviewQuoteSource } from "../../src/adapters/deepbook/deepbookReviewEvidence.js";
import { seedApprovedConnection } from "./walletJournal.js";
import { suiGrants } from "./walletGrants.js";
import type { WalletChainId } from "../../src/core/session/chainAccounts.js";
import { workflowViewSchema } from "../../src/core/session/workflowView.js";
import { FixtureWalletRuntime } from "./walletRuntime.js";
import { BUILD_CHAIN } from "./deepbookBuildClient.js";
import type { EventLogSink } from "../../src/core/eventlog/sink.js";
import { DEFAULT_SUI_GRPC_URL, DEFAULT_SUI_GRAPHQL_URL } from "../../src/runtime/config.js";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { ActionPlan } from "../../src/core/action/types.js";
import { validateSupportedAdapterLifecycle } from "../../src/adapters/adapterLifecycleValidators.js";
import { buildSupportedReviewAdapters } from "../../src/adapters/reviewAdapters.js";
import { createDeepbookSwapHumanReadableReviewProducer } from "../../src/adapters/deepbook/deepbookHumanReviewProducer.js";
import { createTransactionObjectOwnershipProducer } from "../../src/core/action/transactionObjectOwnershipProducer.js";
import { createReviewTimeSimulationProducer } from "../../src/core/action/reviewTimeSimulationEvidence.js";
import { producePtbVisualizationArtifact } from "../../src/core/action/ptbVisualizationProducer.js";
import { SqliteActivityStore } from "../../src/core/activity/sqliteActivityStore.js";
import { LocalSessionStore } from "../../src/core/session/sessionStore.js";
import { WalletWorkflow } from "../../src/core/session/walletWorkflow.js";
import type { WalletTransport, WalletSession } from "../../src/core/session/walletConnection.js";
import type { WalletRuntime } from "../../src/core/session/walletRuntime.js";
import { createCardStore } from "../../src/mcp-ui/readCards.js";
import { createDeepbookUsdcChartService } from "../../src/core/read/deepbookUsdcChartService.js";
import { verifySuiChainReceipt, type SuiChainReceiptVerifierClient } from "../../src/core/action/suiChainReceiptVerifier.js";
import { recordTestTransactionMaterial } from "./transactionMaterial.js";
import { withGrpcSimulation, createSuccessfulReviewTimeSimulationClient, createFailedReviewTimeSimulationClient } from "./reviewTimeSimulation.js";
import { deepbookDisplayQuote } from "./deepbookQuote.js";
import { RuntimeDataAccess } from "../../src/runtime/shared/dataAccess.js";
import type { CardResponse } from "../../src/core/session/cardSession.js";

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Synthetic quote/object/simulation/wallet/chain sources. Core preparation,
// SQLite admission, signature verification, receipt verification and projection
// are real. These fixtures do not establish adapter-build or mainnet success.
export async function walletWorkflowFixture(options: {
  quoteSource?: DeepbookSwapReviewQuoteSource;
  existingStore?: SqliteActivityStore;
  availableDeepRaw?: string; receiptDetails?: boolean; eventLog?: EventLogSink; addressBalance?: boolean;
  createRuntime?: (directory: string, context: { account: string }) => WalletRuntime | Promise<WalletRuntime>;
  accountReader?: Parameters<typeof createCardStore>[0]["readService"]["summarizeAccountInventory"] } = {}) {
  const chainIdentifier = BUILD_CHAIN;
  const directory = mkdtempSync(join(tmpdir(), "sui-mcp-wallet-workflow-"));
  const access = new RuntimeDataAccess();
  let clock = Date.now();
  const now = () => new Date(clock);
  const ownerId = "fixture-owner";
  const accountKey = Ed25519Keypair.generate();
  const account = accountKey.toSuiAddress();
  const activity = options.existingStore ?? new SqliteActivityStore({ databasePath: join(directory, "activity.sqlite"), guardDatabase: access.guardDatabase,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle });
  if (!options.existingStore) await activity.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL });
  let runtime: WalletRuntime | undefined;
  const cardRecords = activity.createCardRecordStore(), records = activity.createWalletWorkflowStore(ownerId, now, () => runtime?.snapshot());
  const materialStore = activity.createTransactionMaterialStore();
  const logger = { info() {}, warn() {}, error: vi.fn() };
  const sessions = new LocalSessionStore({ verifySwapMinimum: verifyInstalledMinimum, now, ...(options.eventLog ? { eventLog: options.eventLog } : {}), ownerId, activityStore: activity, transactionMaterialStore: materialStore,
    sessions: activity.createSessionRecordStore(), artifacts: activity.createPrivateReviewArtifactStore(),
    logger, validateAdapterLifecycle: validateSupportedAdapterLifecycle });
  // Preserve errors from real preparation/storage for actionable fixture failures.
  const preparationErrors: unknown[] = [];
  for (const method of ["recordWalletConnected", "recordReviewStateWithArtifacts"] as const) {
    const original = sessions[method].bind(sessions);
    vi.spyOn(sessions, method).mockImplementation(async (...args: unknown[]) => {
      try { return await Reflect.apply(original, sessions, args); }
      catch (error) { preparationErrors.push(error); throw error; }
    });
  }
  const approved = new Map<string, WalletSession>();
  const approval = deferred<WalletSession>();
  const listeners = new Set<(topic: string, changedChains?: readonly WalletChainId[]) => void>();
  const signatures = new Map<string, Uint8Array>();
  const sign = vi.fn<WalletTransport["sign"]>(async (input) => {
    const bytes = Buffer.from(input.transactionBytesBase64, "base64");
    const result = await accountKey.signTransaction(bytes);
    signatures.set(result.signature, bytes);
    return { transactionBytes: result.bytes, signature: result.signature };
  });
  const connect = vi.fn<WalletTransport["connect"]>(async () => ({
    uri: `wc:fixture@2?relay-protocol=irn&symKey=${"ab".repeat(32)}`,
    expiresAt: new Date(clock + 300_000).toISOString(),
    approval: approval.promise.then((value) => { approved.set(value.topic, value); return value; })
  }));
  const transport: WalletTransport = { connect, sign, cleanupPairings: async () => {},
    session: (topic) => approved.get(topic),
    inspect: (topic) => { const session = transport.session(topic); return session ? { topic, status: "present", session } : { topic, status: "absent" }; },
    inspectAll: () => [...approved.keys()].map((topic) => transport.inspect(topic)),
    disconnect: vi.fn(async (topic) => { approved.delete(topic); }), stop: vi.fn(),
    onSessionChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); } } };
  let sourceAccount = account;
  const simulate = vi.fn((input: Parameters<ReturnType<typeof createSuccessfulReviewTimeSimulationClient>["core"]["simulateTransaction"]>[0]) =>
    createSuccessfulReviewTimeSimulationClient(sourceAccount).core.simulateTransaction(input));
  const simulation = withGrpcSimulation({ core: { simulateTransaction: simulate } });
  const digests = new Map<string, Awaited<ReturnType<typeof recordTestTransactionMaterial>>["digest"]>();
  let lastBytes: Uint8Array | undefined;
  const quote = vi.fn(async () => deepbookDisplayQuote({ fetchedAt: now().toISOString() }));
  const computation = { validateAdapterLifecycle: validateSupportedAdapterLifecycle,
    adapters: buildSupportedReviewAdapters({ deepbook: {
      deepbookQuoteSource: options.quoteSource ?? { quoteDeepbookDisplayAmount: quote },
      deepbookDeepBalanceSource: async () => options.availableDeepRaw ?? "25000",
      gasFeePolicySource: async () => ({ enabled: false, additionalTakerFeeRaw: "1000000" }),
      deepbookTransactionMaterialProducer: async (input) => {
        const material = await recordTestTransactionMaterial({ swap: input, materialStore, reviewSessionId: input.reviewSessionId,
          planId: input.plan.id, account: input.account, now: input.now, expiresAt: new Date(input.quotePolicy.expiresAt), includeSharedObject: true, addressBalance: options.addressBalance });
        digests.set(input.reviewSessionId, material.digest);
        lastBytes = materialStore.getTransactionMaterial(material.handle, input.now)!.transactionBytes;
        return { status: "completed" as const, evidence: material.handle, ...(material.guardCommand !== undefined ? { guardCommand:material.guardCommand } : {}), checks: [] };
      },
      deepbookTransactionMaterialDigestProducer: async (input) => ({ status: "completed" as const, evidence: digests.get(input.materialHandle.reviewSessionId)!, checks: [] }),
      transactionObjectOwnershipProducer: createTransactionObjectOwnershipProducer({ materialStore,
        fundingSource: { getCurrentSystemState: async () => ({ systemState: { epoch: "1" } }),
          getBalance: async ({ coinType }) => ({ balance: { coinType, addressBalance: "2000000000" } }) },
        objectSource: { getObject: async ({ objectId }) => ({ object: { objectId,
          owner: isFixtureSharedObject(objectId) ? { $kind: "Shared" as const, Shared: { initialSharedVersion: "1" } } : { $kind: "AddressOwner" as const, AddressOwner: sourceAccount },
          type: isFixtureSharedObject(objectId) ? "0x2::clock::Clock" : "0x2::coin::Coin<0x2::sui::SUI>" } }) },
        network: "mainnet", chainIdentifier, expectedChainIdentifier: chainIdentifier }),
      deepbookHumanReadableReviewProducer: createDeepbookSwapHumanReadableReviewProducer(),
      reviewTimeSimulationProducer: createReviewTimeSimulationProducer({ client: simulation, materialStore,
        network: "mainnet", chainIdentifier, expectedChainIdentifier: chainIdentifier }),
      ptbVisualizationProducer: (input) => producePtbVisualizationArtifact({ materialStore, ...input })
    } }) };
  const submit = vi.fn(async (_bytes: Uint8Array, _signature: string) => ({}));
  let chainFailure = false;
  const failedChain = createFailedReviewTimeSimulationClient("Fixture Move abort");
  const chainRead = vi.fn(async () => {
    if (!lastBytes) throw new Error("Fixture transaction is missing");
    return (chainFailure ? failedChain : simulation).core.simulateTransaction({ transaction: lastBytes, checksEnabled: true,
      include: { transaction: true, effects: true, balanceChanges: true, objectTypes: true } });
  });
  const chain: SuiChainReceiptVerifierClient = { core: { getChainIdentifier: async () => ({ chainIdentifier }),
    getTransaction: chainRead } };
  const verifyReceipt = (input: Parameters<typeof verifySuiChainReceipt>[1]) => verifySuiChainReceipt({ client: chain, network: "mainnet", expectedChainIdentifier: chainIdentifier, includeDisplay: options.receiptDetails ?? false }, input);
  const verifyNetwork = vi.fn(async () => {});
  runtime = options.createRuntime ? await options.createRuntime(directory, { account }) : new FixtureWalletRuntime(transport);
  const workflow = new WalletWorkflow({ records, sessions, ownerId, runtime, computation,
    verifyReceipt,
    submitTransaction: submit, verifyNetwork, assertCurrent: access.assertCurrent,
    bindExternalEvent: (work) => access.bind(work), logger, now });
  if (!options.existingStore) await workflow.start();
  // Real child/SDK integration uses the same observation budget as the SDK tests.
  if (!options.existingStore) await vi.waitFor(() => expectAvailable(), options.createRuntime ? { timeout: 10000 } : undefined);
  function expectAvailable() { if (runtime!.availability().status !== "available") throw new Error("Fixture wallet service did not become available"); }
  const cards = createCardStore({ records: cardRecords, ownerId, assertCurrent: access.assertCurrent, workflow, now,
    readService: { summarizeAccountInventory: options.accountReader ?? (async () => { throw new Error("Unexpected account source"); }) },
    publicChainReceiptReader: async () => { throw new Error("Unexpected receipt source"); }, chart: createDeepbookUsdcChartService() });
  const localData = activity.createLocalDataService({ now, advanceRequestDeadlines: (at) => records.advanceRequestDeadlines(at),
    onDataReplaced: () => { access.dataReplaced(); workflow.dataReplaced(); }, suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
    verifySuiGrpcUrl: async () => {}, verifySuiGraphqlUrl: async () => {} });
  access.ready();
  const run = <T>(operation: () => T): T => access.run(operation);
  const createConnection = () => run(() => cards.create("connect", {}));
  const createDisconnection = () => run(() => cards.create("disconnect", {}));
  // Capture the same fixed target used by the public swap-review gateway.
  // Later wallet changes do not rewrite the returned card input.
  const reviewInput = (reviewSessionId: string) => run(() => {
    const target = workflow.resolveReviewTarget();
    if (target.status !== "available") throw new Error("A current fixed wallet target is required by this review fixture.");
    return { reviewSessionId, connectionId: target.connectionId, account: target.account };
  });
  const connectionInput = (card: CardResponse, input: Record<string, unknown>): Record<string, unknown> => {
    const parsed = workflowViewSchema.safeParse(card.snapshot.data), data = parsed.success ? parsed.data : undefined;
    const connection = data?.kind === "disconnect" && data.connection?.connectionId === input.connectionId ? data.connection : undefined;
    const common = { walletRunId: data?.walletAvailability.walletRunId ?? runtime!.runId, ...input };
    if (input.action === "connect") return { operationId: card.snapshot.input.operationId, chains: card.snapshot.input.requestedChains, ...common };
    if (input.action === "disconnect") return { operationId: card.snapshot.input.operationId, impactId: connection?.disconnectImpact?.impactId, ...common };
    if (input.action === "stop_connection") return { operationId: card.snapshot.input.operationId, ...input };
    return ["prepare_review", "request_signature"].includes(String(input.action)) ? common : input;
  };
  const act = (card: CardResponse & { permission: string }, input: Record<string, unknown>) => run(() => cards.act({
    cardId: card.snapshot.cardId, permission: card.permission, revision: card.snapshot.revision, input: connectionInput(card, input)
  }));
  const read = (card: CardResponse & { permission: string }) => run(async () => ({
    ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission }));
  const plan: ActionPlan = { id: "fixture-plan", actionKind: "swap", adapterId: "deepbook-swap", protocol: "DeepBookV3", title: "Review swap", summary: "Review a swap",
    createdAt: now().toISOString(), assetFlowPreview: { outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
      expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }] },
    adapterData: { requestedIntent: { type: "swap", from: { symbol: "SUI", amountDisplay: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 } } };
  const approve = async () => {
    let card = await createConnection();
    await act(card, { action: "connect" });
    await vi.waitFor(() => { if (!connect.mock.calls.length) throw new Error("Pairing not started"); });
    approval.resolve({ topic: "fixture-topic", grants: suiGrants([account], ["sui_signTransaction"]), expiresAt: new Date(clock + 1_800_000).toISOString(), walletName: "Fixture Wallet" });
    await vi.waitFor(() => { if (run(() => records.connections()[0]?.connection.status) !== "connected") throw new Error("Approval not recorded"); });
    card = await read(card);
    return { card, connection: run(() => records.connections()[0]!.connection) };
  };
  const connectSession = async (session: WalletSession) => {
    connect.mockImplementationOnce(async () => ({ uri: `wc:fixture@2?relay-protocol=irn&symKey=${"ab".repeat(32)}`,
      expiresAt: new Date(clock + 300_000).toISOString(),
      approval: Promise.resolve().then(() => { approved.set(session.topic, session); return session; }) }));
    const card = await createConnection();
    const response = await act(card, { action: "connect" });
    if (response.error) throw new Error(response.error.message);
    await vi.waitFor(() => {
      const value = run(() => records.connections().find((item) => item.topic === session.topic));
      if (value?.connection.status !== "connected" || value.sdkPending) throw new Error("Fixture approval not settled");
    });
    return run(() => records.connections().find((item) => item.topic === session.topic)!);
  };
  const prepare = async (connectionId: string, reviewPlan: ActionPlan = plan) => {
    const created = await run(() => sessions.createReviewSession([reviewPlan], now()));
    let card = await run(() => cards.create("review", { reviewSessionId: created.session.id, connectionId, account }));
    const response = await act(card, { action: "prepare_review", connectionId, account, reviewRevision: 0 });
    if (response.error) throw new Error(response.error.message);
    await vi.waitFor(async () => {
      const review = await run(() => sessions.getReviewSession(created.session.id, now));
      if (preparationErrors.length) throw preparationErrors[0];
      if (review?.status !== "ready_for_wallet_review" || review.preparationId) throw new Error(`Review not ready: ${JSON.stringify(review?.reviewState)}`);
    });
    card = await read(card);
    const session = await run(() => sessions.getReviewSession(created.session.id, now));
    return { card, session: session! };
  };
  return { directory, access, run, activity, localData, cards, cardRecords, records, sessions, workflow, runtime, transport, accountKey, account, sign, connect, submit, chainRead, quote, simulate,
    approval, createConnection, createDisconnection, reviewInput, connectionInput, act, read, approve, connectSession, prepare, now, plan, logger, verifyNetwork, computation, verifyReceipt,
    seedConnection(session: WalletSession) { return seedApprovedConnection(join(directory, "activity.sqlite"), session, { ownerId, runId: runtime.runId, at: now() }); },
    setChainOutcome(status: "success" | "failure") { chainFailure = status === "failure"; },
    // Explicit synthetic object/simulation ownership, independent of the selected
    // product account. Signing still uses accountKey unless a test replaces it.
    setSourceAccount(value: string) { sourceAccount = value; },
    advance(ms: number) { clock += ms; },
    notify(session?: WalletSession, changedChains?: readonly WalletChainId[]) { if (session) approved.set(session.topic, session); else approved.delete("fixture-topic"); for (const listener of listeners) listener("fixture-topic", changedChains); },
    removeSession(topic: string) { approved.delete(topic); for (const listener of listeners) listener(topic); },
    observe() { for (const listener of listeners) listener("fixture-topic"); },
    holdWalletExit() {
      if (!(runtime instanceof FixtureWalletRuntime)) throw new Error("Only the external runtime double supports holding its exit.");
      return runtime.holdExit();
    },
    close() { workflow.stop(); void runtime.close(); cards.stop(); access.close(); if (!options.existingStore) activity.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
