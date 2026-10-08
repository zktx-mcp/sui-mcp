import { FixtureWalletRuntime } from "./walletRuntime.js";
import { BUILD_CHAIN } from "./deepbookBuildClient.js";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import type { EventLogSink } from "../../src/core/eventlog/sink.js";
import { readPublicChainReceipt } from "../../src/core/action/suiChainReceiptReader.js";
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
import { createReadCardStore } from "../../src/mcp-ui/readCards.js";
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
export async function walletWorkflowFixture(options: { receiptDetails?: boolean; eventLog?: EventLogSink; addressBalance?: boolean;
  createRuntime?: (directory: string, context: { account: string }) => WalletRuntime | Promise<WalletRuntime>;
  accountReader?: Parameters<typeof createReadCardStore>[0]["readService"]["summarizeAccountInventory"] } = {}) {
  const chainIdentifier = options.addressBalance ? BUILD_CHAIN : "mainnet-chain";
  const directory = mkdtempSync(join(tmpdir(), "sui-mcp-wallet-workflow-"));
  const access = new RuntimeDataAccess();
  let clock = Date.now();
  const now = () => new Date(clock);
  const ownerId = "fixture-owner";
  const accountKey = Ed25519Keypair.generate();
  const account = accountKey.toSuiAddress();
  const activity = new SqliteActivityStore({ databasePath: join(directory, "activity.sqlite"), guardDatabase: access.guardDatabase,
    validateAdapterLifecycle: validateSupportedAdapterLifecycle });
  await activity.createPreferencesRepository().ensureDefaultLocalSettings({ suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL });
  let runtime: WalletRuntime | undefined;
  const cardRecords = activity.createCardRecordStore(), records = activity.createWalletWorkflowStore(ownerId, now, () => runtime?.snapshot());
  const materialStore = activity.createTransactionMaterialStore();
  const logger = { info() {}, warn() {}, error: vi.fn() };
  const sessions = new LocalSessionStore({ now, ...(options.eventLog ? { eventLog: options.eventLog } : {}), ownerId, activityStore: activity, transactionMaterialStore: materialStore,
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
  let approved: WalletSession | undefined;
  const approval = deferred<WalletSession>();
  const listeners = new Set<(topic: string, selectionChanged?: boolean) => void>();
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
    approval: approval.promise.then((value) => { approved = value; return value; })
  }));
  const transport: WalletTransport = { connect, sign, restore: async () => [],
    session: (topic) => approved?.topic === topic ? approved : undefined,
    inspect: (topic) => { const session = transport.session(topic); return session ? { topic, status: "present", session } : { topic, status: "absent" }; },
    inspectAll: () => approved ? [transport.inspect(approved.topic)] : [],
    disconnect: vi.fn(async () => { approved = undefined; }), stop: vi.fn(),
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
      deepbookQuoteSource: { quoteDeepbookDisplayAmount: quote },
      deepbookTransactionMaterialProducer: async (input) => {
        const material = await recordTestTransactionMaterial({ materialStore, reviewSessionId: input.reviewSessionId,
          planId: input.plan.id, account: input.account, now: input.now, expiresAt: new Date(input.now.getTime() + 30_000), includeSharedObject: true, addressBalance: options.addressBalance });
        digests.set(input.reviewSessionId, material.digest);
        lastBytes = materialStore.getTransactionMaterial(material.handle, input.now)!.transactionBytes;
        return { status: "completed" as const, evidence: material.handle, checks: [] };
      },
      deepbookTransactionMaterialDigestProducer: async (input) => ({ status: "completed" as const, evidence: digests.get(input.materialHandle.reviewSessionId)!, checks: [] }),
      transactionObjectOwnershipProducer: createTransactionObjectOwnershipProducer({ materialStore,
        fundingSource: { getCurrentSystemState: async () => ({ systemState: { epoch: "1" } }),
          getBalance: async () => ({ balance: { coinType: SUI_TYPE_ARG, addressBalance: "2000000000" } }) },
        objectSource: { getObject: async ({ objectId }) => ({ object: { objectId,
          owner: objectId === `0x${"c".repeat(64)}` ? { $kind: "Shared" as const, Shared: { initialSharedVersion: "1" } } : { $kind: "AddressOwner" as const, AddressOwner: sourceAccount },
          type: objectId === `0x${"c".repeat(64)}` ? "0x2::clock::Clock" : "0x2::coin::Coin<0x2::sui::SUI>" } }) },
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
    getTransaction: chainRead, waitForTransaction: chainRead } };
  const verifyReceipt = (input: Parameters<typeof verifySuiChainReceipt>[1]) => verifySuiChainReceipt({ client: chain, network: "mainnet", expectedChainIdentifier: chainIdentifier }, input);
  const verifyNetwork = vi.fn(async () => {});
  runtime = options.createRuntime ? await options.createRuntime(directory, { account }) : new FixtureWalletRuntime(transport);
  const workflow = new WalletWorkflow({ records, sessions, ownerId, runtime, computation,
    verifyReceipt,
    ...(options.receiptDetails ? { readReceipt: (input: { digest: string; now: Date }) => readPublicChainReceipt({
      client: { core: { getChainIdentifier: chain.core.getChainIdentifier, getTransaction: async () => {
        const result = await chainRead();
        return result.$kind === "Transaction" ? { ...result, Transaction: { ...result.Transaction, events: [] } } :
          { ...result, FailedTransaction: { ...result.FailedTransaction, events: [] } };
      } } }, network: "mainnet", expectedChainIdentifier: chainIdentifier
    }, input) } : {}),
    submitTransaction: submit, verifyNetwork, assertCurrent: access.assertCurrent,
    bindExternalEvent: (work) => access.bind(work), logger, now });
  await workflow.start();
  // Real child/SDK integration uses the same observation budget as the SDK tests.
  await vi.waitFor(() => expectAvailable(), options.createRuntime ? { timeout: 10000 } : undefined);
  function expectAvailable() { if (runtime!.availability().status !== "available") throw new Error("Fixture wallet service did not become available"); }
  const cards = createReadCardStore({ records: cardRecords, ownerId, assertCurrent: access.assertCurrent, workflow, now,
    readService: { summarizeAccountInventory: options.accountReader ?? (async () => { throw new Error("Unexpected account source"); }) },
    publicChainReceiptReader: async () => { throw new Error("Unexpected receipt source"); }, chart: createDeepbookUsdcChartService() });
  const localData = activity.createLocalDataService({ now, advanceRequestDeadlines: (at) => records.advanceRequestDeadlines(at),
    onDataReplaced: () => { access.dataReplaced(); workflow.dataReplaced(); }, suiGrpcUrl: DEFAULT_SUI_GRPC_URL, suiGraphqlUrl: DEFAULT_SUI_GRAPHQL_URL,
    verifySuiGrpcUrl: async () => {}, verifySuiGraphqlUrl: async () => {} });
  access.ready();
  const run = <T>(operation: () => T): T => access.run(operation);
  const createConnection = () => run(() => cards.create("connect", { intent: "connect" }));
  const act = (card: CardResponse & { permission: string }, input: Record<string, unknown>) => run(() => cards.act({
    cardId: card.snapshot.cardId, permission: card.permission, revision: card.snapshot.revision, input: ["connect", "disconnect", "use_account", "prepare_review", "request_signature", "restart_wallet_service"].includes(String(input.action))
      ? { walletRunId: (card.snapshot.data as { walletAvailability: { walletRunId: string } }).walletAvailability.walletRunId, ...input } : input
  }));
  const read = (card: CardResponse & { permission: string }) => run(async () => ({ ...await cards.read({ cardId: card.snapshot.cardId, permission: card.permission }), permission: card.permission }));
  const plan: ActionPlan = { id: "fixture-plan", actionKind: "swap", adapterId: "deepbook-swap", protocol: "DeepBookV3", title: "Review swap", summary: "Review a swap",
    createdAt: now().toISOString(), assetFlowPreview: { outgoing: [{ symbol: "SUI", amount: "1", amountKind: "display_intent" }],
      expectedIncoming: [{ symbol: "USDC", amount: "unknown", amountKind: "display_intent", approx: true }] },
    adapterData: { requestedIntent: { type: "swap", from: { symbol: "SUI", amountDisplay: "1" }, to: { symbol: "USDC" }, maxSlippageBps: 50 } } };
  const approve = async () => {
    let card = await createConnection();
    await act(card, { action: "connect" });
    await vi.waitFor(() => { if (!connect.mock.calls.length) throw new Error("Pairing not started"); });
    approval.resolve({ topic: "fixture-topic", accounts: [account], methods: ["sui_signTransaction"], chain: "sui:mainnet",
      expiresAt: new Date(clock + 1_800_000).toISOString(), walletName: "Fixture Wallet" });
    await vi.waitFor(() => { if (run(() => records.connections()[0]?.connection.status) !== "connected") throw new Error("Approval not recorded"); });
    card = await read(card);
    return { card, connection: run(() => records.connections()[0]!.connection) };
  };
  const prepare = async (connectionId: string) => {
    const created = await run(() => sessions.createReviewSession([plan], now()));
    let card = await run(() => cards.create("review", { reviewSessionId: created.session.id }));
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
    approval, createConnection, act, read, approve, prepare, now, plan, logger, verifyNetwork, computation, verifyReceipt,
    setChainOutcome(status: "success" | "failure") { chainFailure = status === "failure"; },
    // Explicit synthetic object/simulation ownership, independent of the selected
    // product account. Signing still uses accountKey unless a test replaces it.
    setSourceAccount(value: string) { sourceAccount = value; },
    advance(ms: number) { clock += ms; },
    notify(session?: WalletSession, selectionChanged = false) { approved = session; for (const listener of listeners) listener("fixture-topic", selectionChanged); },
    observe() { for (const listener of listeners) listener("fixture-topic"); },
    holdWalletExit() {
      if (!(runtime instanceof FixtureWalletRuntime)) throw new Error("Only the external runtime double supports holding its exit.");
      return runtime.holdExit();
    },
    close() { workflow.stop(); void runtime.close(); cards.stop(); access.close(); activity.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}
