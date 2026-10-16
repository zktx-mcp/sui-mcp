import { beforeEach, expect, it, vi } from "vitest";
import { createWalletConnectTransport } from "../src/runtime/walletConnectTransport.js";
import { WalletUserRejectedError } from "../src/core/session/walletConnection.js";

const sdk = vi.hoisted(() => ({ init: vi.fn(), connect: vi.fn(), request: vi.fn(), disconnect: vi.fn(),
  sessions: new Map<string, unknown>(), listeners: new Map<string, (event: any) => void>(),
  pairings: [] as Array<{ topic: string; expiry: number; active: boolean }>, removePairing: vi.fn() }));
vi.mock("@walletconnect/sign-client", () => ({ SignClient: { init: sdk.init } }));
// The private storage implementation is exercised separately with real files;
// this adapter test never starts the SDK, a relay or wallet network connection.
vi.mock("../src/runtime/walletConnectStorage.js", () => ({ openWalletConnectStorage: () => ({ storage: {}, closeBeforeSdkUse() {} }) }));
const account = `0x${"a".repeat(64)}`;
const approved = () => ({ topic: "approved", expiry: Math.floor(Date.now() / 1000) + 3600,
  namespaces: { sui: { accounts: [`sui:mainnet:${account}`], methods: ["sui_signTransaction"], events: ["accountsChanged", "chainChanged"] } },
  peer: { metadata: { name: "Fixture Wallet" } } });
beforeEach(() => {
  sdk.init.mockReset(); sdk.connect.mockReset(); sdk.request.mockReset(); sdk.disconnect.mockReset(); sdk.removePairing.mockReset();
  sdk.sessions.clear(); sdk.listeners.clear(); sdk.pairings = [];
  sdk.init.mockResolvedValue({ connect: sdk.connect, request: sdk.request, disconnect: sdk.disconnect,
    session: { get: (topic: string) => sdk.sessions.get(topic), getAll: () => [...sdk.sessions.values()] },
    core: { pairing: { getPairings: () => sdk.pairings, disconnect: sdk.removePairing } },
    on: (name: string, listener: (event: any) => void) => sdk.listeners.set(name, listener),
    off: (name: string, listener: (event: any) => void) => { if (sdk.listeners.get(name) === listener) sdk.listeners.delete(name); } });
});
const open = () => createWalletConnectTransport({ projectId: "1".repeat(32), dataDirectory: "unused-fixture", metadata: { name: "Fixture", description: "No network", url: "https://example.invalid" } });

it("validates the project identifier before initializing the SDK", async () => {
  await expect(createWalletConnectTransport({ projectId: "invalid", dataDirectory: "unused-fixture",
    metadata: { name: "Fixture", description: "No network", url: "https://example.invalid" } })).rejects.toThrow("project ID format is invalid");
  expect(sdk.init).not.toHaveBeenCalled();
});

it("uses the pinned Sui sign-only RPC with unchanged stored BCS and selected address", async () => {
  sdk.sessions.set("approved", approved()); sdk.request.mockResolvedValue({ transactionBytes: "AQID", signature: "fixture-signature" });
  const transport = await open();
  try {
    expect(await transport.sign({ topic: "approved", account, transactionBytesBase64: "AQID" })).toEqual({ transactionBytes: "AQID", signature: "fixture-signature" });
    expect(sdk.request).toHaveBeenCalledExactlyOnceWith({ topic: "approved", chainId: "sui:mainnet",
      request: { method: "sui_signTransaction", params: { transaction: "AQID", address: account } } });
    expect(sdk.init.mock.calls[0]?.[0]).toMatchObject({ logger: "silent", telemetryEnabled: false, storage: {} });
    await expect(transport.sign({ topic: "approved", account: `0x${"b".repeat(64)}`, transactionBytesBase64: "AQID" })).rejects.toThrow("selected Sui account");
    expect(sdk.request).toHaveBeenCalledOnce();
  } finally { transport.stop(); }
});

it("invalidates selection on account/chain events even if approved namespaces do not change", async () => {
  sdk.sessions.set("approved", approved()); const transport = await open(), listener = vi.fn(); transport.onSessionChanged(listener);
  for (const name of ["accountsChanged", "chainChanged"]) sdk.listeners.get("session_event")!({ topic: "approved", params: { event: { name } } });
  expect(listener.mock.calls).toEqual([["approved", ["sui:mainnet", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]],
    ["approved", ["sui:mainnet", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]]]);
  expect(transport.session("approved")?.grants[0]?.accounts.map((item) => item.address)).toEqual([account]);
  transport.stop(); expect(sdk.listeners.size).toBe(0); expect(transport.session("approved")).toBeUndefined();
});

it("keeps a non-mainnet session unusable for supported accounts and removes abandoned pairings", async () => {
  sdk.sessions.set("approved", approved()); const wrong = approved(); wrong.topic = "wrong"; wrong.namespaces.sui.accounts = [`sui:testnet:${account}`]; sdk.sessions.set("wrong", wrong);
  sdk.pairings = [{ topic: "abandoned", expiry: Math.floor(Date.now() / 1000) + 60, active: false }];
  const transport = await open();
  try { expect((await transport.restore()).map((s) => s.topic)).toEqual(["approved", "wrong"]); expect(transport.session("wrong")?.grants.flatMap((grant) => grant.accounts)).toEqual([]); expect(sdk.removePairing).toHaveBeenCalledExactlyOnceWith({ topic: "abandoned" }); }
  finally { transport.stop(); }
});

it("takes pairing expiry from the SDK and classifies rejection by protocol code rather than prose", async () => {
  const expiry = Math.floor(Date.now() / 1000) + 300;
  sdk.pairings = [{ topic: "pair", expiry, active: false }];
  sdk.connect.mockResolvedValue({ uri: "wc:pair@2?relay-protocol=irn&symKey=fixture", approval: async () => { throw { code: 5000, message: "PRIVATE-REMOTE-DETAIL" }; } });
  const transport = await open();
  try {
    const pairing = await transport.connect(["sui:mainnet", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    expect(sdk.connect).toHaveBeenCalledExactlyOnceWith({ requiredNamespaces: {}, optionalNamespaces: {
      sui: { chains: ["sui:mainnet"], methods: ["sui_signTransaction"], events: ["accountsChanged", "chainChanged"] },
      eip155: { chains: ["eip155:1"], methods: [], events: [] },
      solana: { chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"], methods: [], events: [] }
    } });
    expect(pairing.expiresAt).toBe(new Date(expiry * 1000).toISOString());
    await expect(pairing.approval).rejects.toBeInstanceOf(WalletUserRejectedError);
    await expect(pairing.approval).rejects.not.toThrow("PRIVATE-REMOTE-DETAIL");
    sdk.connect.mockResolvedValue({ uri: "wc:pair@2?relay-protocol=irn&symKey=fixture", approval: async () => { throw { code: -32000, message: "User rejected" }; } });
    await expect((await transport.connect(["sui:mainnet"])).approval).rejects.not.toBeInstanceOf(WalletUserRejectedError);
  } finally { transport.stop(); }
});
