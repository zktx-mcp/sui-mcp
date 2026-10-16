import { SignClient } from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";
import { z } from "zod";
import { normalizeWalletGrants, walletChainsSchema, walletGrantAccount, WALLET_CHAINS, type WalletChainId } from "../core/session/chainAccounts.js";
import { SUI_MAINNET_WALLET_CHAIN, SUI_SIGN_TRANSACTION_METHOD,
  WalletUserRejectedError, type WalletSession, type WalletTransport } from "../core/session/walletConnection.js";
import { openWalletConnectStorage } from "./walletConnectStorage.js";
import type { WalletSessionInspection } from "../core/session/walletRuntime.js";

const signedResponse = z.object({ transactionBytes: z.string().min(1), signature: z.string().min(1) }).strict();
function transportError(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return ["USER_REJECTED", "USER_REJECTED_CHAINS", "USER_REJECTED_METHODS", "USER_REJECTED_EVENTS"]
    .some((name) => getSdkError(name as Parameters<typeof getSdkError>[0]).code === code)
    ? new WalletUserRejectedError() : new Error("The wallet request could not be completed.");
}

function sessionValue(session: SessionTypes.Struct): WalletSession {
  if (!Number.isSafeInteger(session.expiry) || session.expiry * 1000 <= Date.now()) {
    throw new Error("A live wallet session is required.");
  }
  return { topic: session.topic, grants: normalizeWalletGrants(session.namespaces),
    expiresAt: new Date(session.expiry * 1000).toISOString(), walletName: session.peer.metadata.name };
}

export async function createWalletConnectTransport(options: {
  projectId: string; dataDirectory: string; metadata: { name: string; description: string; url: string };
  onSdkStart?: () => void;
  initialize?: typeof SignClient.init;
}): Promise<WalletTransport> {
  if (!/^[0-9a-f]{32}$/i.test(options.projectId)) throw new Error("WalletConnect project ID format is invalid.");
  const owner = openWalletConnectStorage(options.dataDirectory);
  // SDK log bodies can contain pairing credentials and serialized requests.
  // Product failure stages are recorded by the caller without these values.
  options.onSdkStart?.();
  const client = await (options.initialize ?? SignClient.init.bind(SignClient))({ projectId: options.projectId, metadata: { ...options.metadata, icons: [] },
    storage: owner.storage, logger: "silent", telemetryEnabled: false });
  let stopped = false;
  const listeners = new Set<(topic: string, changedChains?: readonly WalletChainId[]) => void>();
  const changed = (event: { topic: string }) => { if (!stopped) for (const listener of listeners) listener(event.topic); };
  // Pinned SignClient emits session_event without changing session.namespaces.
  // Treat active account/chain changes as invalidation, not new authorization.
  const selectionChanged = (event: { topic: string; params: { chainId?: string; event: { name: string } } }) => {
    if (!stopped && ["accountsChanged", "chainChanged"].includes(event.params.event.name)) {
      const chain = WALLET_CHAINS.find((id) => id === event.params.chainId);
      for (const listener of listeners) listener(event.topic, chain ? [chain] : WALLET_CHAINS);
    }
  };
  client.on("session_update", changed); client.on("session_delete", changed);
  client.on("session_expire", changed); client.on("session_event", selectionChanged);
  const inspectValue = (session: SessionTypes.Struct): WalletSessionInspection => {
    try { return { topic: session.topic, status: "present", session: sessionValue(session) }; }
    catch { return { topic: session.topic, status: "unusable" }; }
  };
  const inspect = (topic: string): WalletSessionInspection => {
    if (stopped) throw new Error("WalletConnect owner stopped.");
    // A store failure is not evidence that the session disappeared.
    const session = client.session.getAll().find((item) => item.topic === topic);
    return session ? inspectValue(session) : { topic, status: "absent" };
  };
  const current = (topic: string) => {
    if (stopped) return undefined;
    const observed = inspect(topic);
    return observed.status === "present" ? observed.session : undefined;
  };
  const requireActive = () => { if (stopped) throw new Error("WalletConnect owner stopped."); };
  return {
    async restore() {
      requireActive();
      // A pending proposal is not an approved session and must not reappear as
      // a new approval ceremony after owner replacement.
      for (const pairing of client.core.pairing.getPairings()) {
        if (!pairing.active) await client.core.pairing.disconnect({ topic: pairing.topic });
      }
      return client.session.getAll().flatMap((session) => { const value = current(session.topic); return value ? [value] : []; });
    },
    async connect(chains) {
      requireActive();
      const scope = walletChainsSchema.parse(chains);
      if (!scope.length) throw new Error("Choose wallet networks in Settings before connecting.");
      const optionalNamespaces = Object.fromEntries(scope.map((chain) => [chain.split(":")[0]!, { chains: [chain],
        methods: chain === SUI_MAINNET_WALLET_CHAIN ? [SUI_SIGN_TRANSACTION_METHOD] : [],
        events: chain === SUI_MAINNET_WALLET_CHAIN ? ["accountsChanged", "chainChanged"] : [] }]));
      const connecting = await client.connect({ requiredNamespaces: {}, optionalNamespaces });
      const approval = connecting.approval().then(sessionValue).catch((error: unknown) => { throw transportError(error); });
      // Attach a rejection handler immediately; the backend records the same
      // promise's outcome once the private QR has been associated with its row.
      void approval.catch(() => undefined);
      if (!connecting.uri) throw new Error("The wallet pairing could not be prepared.");
      const topic = /^wc:([^@]+)@2\?/.exec(connecting.uri)?.[1];
      const pairing = topic ? client.core.pairing.getPairings().find((item) => item.topic === topic) : undefined;
      if (!pairing || !Number.isSafeInteger(pairing.expiry)) throw new Error("Wallet pairing expiry is unavailable.");
      return { uri: connecting.uri, expiresAt: new Date(pairing.expiry * 1000).toISOString(), approval };
    },
    async disconnect(topic) { requireActive(); await client.disconnect({ topic, reason: getSdkError("USER_DISCONNECTED") }); },
    async sign(input) {
      requireActive();
      const session = current(input.topic);
      if (!session || !walletGrantAccount(session.grants, SUI_MAINNET_WALLET_CHAIN, input.account)?.methods.includes(SUI_SIGN_TRANSACTION_METHOD)) {
        throw new Error("This wallet session cannot sign for the selected Sui account.");
      }
      return signedResponse.parse(await client.request({ topic: input.topic, chainId: SUI_MAINNET_WALLET_CHAIN,
        request: { method: SUI_SIGN_TRANSACTION_METHOD, params: { transaction: input.transactionBytesBase64, address: input.account } } }));
    },
    session: current,
    inspect,
    inspectAll: () => { requireActive(); return client.session.getAll().map(inspectValue); },
    onSessionChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop() {
      stopped = true; listeners.clear();
      client.off("session_update", changed); client.off("session_delete", changed);
      client.off("session_expire", changed); client.off("session_event", selectionChanged);
      // SignClient has no supported complete in-process disposal. The runtime
      // ends the owner process; it must not close injected storage under timers.
    }
  };
}
