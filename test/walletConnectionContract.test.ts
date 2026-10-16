import { expect, it } from "vitest";
import { walletConnectionSchema, projectWalletConnection, walletConnectionEligibility, type WalletConnectionPresence } from "../src/core/session/walletConnection.js";
import { suiGrants } from "./fixtures/walletGrants.js";
const account = `0x${"a".repeat(64)}`;
const connection = { connectionId: "fixture", status: "connected", revision: 0,
  requestedChains: ["sui:mainnet"], chainResults: [{ chainId: "sui:mainnet", status: "bound", address: account }],
  approvedAt: new Date(0).toISOString(), grants: suiGrants([account]), lifecycleRevision: 1,
  grantRevisions: { "sui:mainnet": 1, "eip155:1": 1, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": 1 },
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString() };
it.each([
  { available: true, confirmed: true, observed: "absent", expected: "absent" },
  { available: true, confirmed: true, observed: "unusable", expected: "unusable" },
  { available: true, confirmed: true, observed: "present", expected: "present" },
  { available: false, confirmed: true, observed: "absent", expected: "unconfirmed" },
  { available: true, confirmed: false, observed: "absent", expected: "unconfirmed" }
] as const)("projects current session evidence independently of saved failure ($available/$confirmed/$observed)", ({ available, confirmed, observed, expected }) => {
  const saved = walletConnectionSchema.parse({ ...connection, status: "failed" });
  const projected = projectWalletConnection(saved, 0, { confirmed, managed: true, dataCurrent: true, pending: false, hasRecordedSession: true,
    unrecorded: false, observation: { status: observed, expiresAt: saved.expiresAt } }, available)!;
  expect(projected.status).toBe("failed"); expect(projected.sessionPresence).toBe(expected);
  expect(saved).not.toHaveProperty("sessionPresence");
});
it.each([
  { name: "settled attempt without approval", expected: "absent", pairing: true },
  { name: "pending approval or settlement", pending: true, expected: "unconfirmed", pairing: false },
  { name: "unrecorded SDK session", unrecorded: true, expected: "unconfirmed", pairing: false },
  { name: "unconfirmed current run", confirmed: false, expected: "unconfirmed", pairing: false },
  { name: "unconfirmed ownership", managed: false, expected: "unconfirmed", pairing: false },
  { name: "recorded session missing observation", hasRecordedSession: true, expected: "unconfirmed", pairing: false },
  { name: "approval without its session reference", approved: true, expected: "unconfirmed", pairing: false }
])("keeps session absence and pairing consistent for $name", ({ name: _name, expected, pairing, approved = false, ...facts }) => {
  const saved = walletConnectionSchema.parse({ ...connection, status: "rejected", approvedAt: approved ? connection.approvedAt : undefined,
    chainResults: approved ? connection.chainResults : [], grants: approved ? connection.grants : [] });
  const presence: WalletConnectionPresence = { confirmed: true, managed: true, dataCurrent: true, pending: false,
    hasRecordedSession: false, unrecorded: false, ...facts };
  expect(projectWalletConnection(saved, 0, presence, true)?.sessionPresence).toBe(expected);
  expect(walletConnectionEligibility(saved, 0, presence).pairingAllowed).toBe(pairing);
  expect(projectWalletConnection(saved, 0, presence, false)?.sessionPresence).toBe("unconfirmed");
  expect(saved.status).toBe("rejected");
});
it("accepts only exact normalized chain results and excludes private wallet data", () => {
  expect(walletConnectionSchema.parse(connection)).toEqual(connection);
  for (const delta of [{ requestedChains: ["sui:testnet"] }, { chainResults: [{ chainId: "sui:mainnet", status: "bound", address: "not-an-address" }] },
    { chainResults: [...connection.chainResults, ...connection.chainResults] }, { chainResults: [] },
    { status: "opened" }, { signature: "private" }, { topic: "private" }, { initialAccounts: [] }]) {
    expect(walletConnectionSchema.safeParse({ ...connection, ...delta }).success).toBe(false);
  }
});
it("qualifies only the fixed Sui address while keeping retained-session cleanup separate", () => {
  const saved = walletConnectionSchema.parse(connection);
  const presence: WalletConnectionPresence = { confirmed: true, managed: true, dataCurrent: true, pending: false,
    hasRecordedSession: true, unrecorded: false, observation: { status: "present", expiresAt: saved.expiresAt } };
  expect(walletConnectionEligibility(saved, 0, presence, account)).toMatchObject({ manageable: true,
    assetReadAccount: { status: "available", account } });
  for (const delta of [{ readAccount: `0x${"b".repeat(64)}` }, { cleared: true }, { pending: true }, { at: 1000 }]) {
    const result = walletConnectionEligibility(saved, "at" in delta ? delta.at : 0,
      { ...presence, pending: "pending" in delta }, "readAccount" in delta ? delta.readAccount : account, "cleared" in delta);
    expect(result.assetReadAccount.status).toBe("address_required");
    expect(result.manageable).toBe(!("pending" in delta));
  }
});
