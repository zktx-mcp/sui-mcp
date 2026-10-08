import { expect, it } from "vitest";
import { walletConnectionSchema, connectionConflictSchema } from "../src/core/session/walletConnection.js";
import { CONNECT_BOUNDARY, workflowViewSchema } from "../src/core/session/workflowView.js";
const connection = { connectionId: "fixture", status: "connected", revision: 0, chain: "sui:mainnet",
  accounts: [`0x${"a".repeat(64)}`], methods: ["sui_signTransaction"], createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(), expiresAt: new Date(1000).toISOString() };
it("accepts only the current connection model and valid mainnet account identity", () => {
  expect(walletConnectionSchema.parse(connection)).toEqual(connection);
  for (const delta of [{ chain: "sui:testnet" }, { accounts: ["not-an-address"] }, { status: "opened" }, { signature: "private" }, { topic: "private" }]) {
    expect(walletConnectionSchema.safeParse({ ...connection, ...delta }).success).toBe(false);
  }
});

it("requires published account eligibility to name its recorded usable target", () => {
  const view = { kind: "connect", mode: "connect", allowedActions: [], actionRemainingMs: 0, observe: false,
    walletAvailability: { status: "available", walletRunId: "00000000-0000-4000-8000-000000000001" }, progress: { status: "idle" },
    boundary: CONNECT_BOUNDARY, connections: [connection], manageableConnectionIds: [connection.connectionId], activeAccount: connection.accounts[0], usableConnectionId: connection.connectionId,
    assetReadAccount: { status: "available", account: connection.accounts[0] } };
  expect(workflowViewSchema.safeParse(view).success).toBe(true);
  for (const delta of [{ usableConnectionId: "unknown" }, { usableConnectionId: undefined },
    { activeAccount: `0x${"b".repeat(64)}` }, { connections: [{ ...connection, pendingAction: "disconnect" }] },
    { connectionConflict: { reason: "multiple_connections", connectionIds: [connection.connectionId, "other"] } }]) {
    expect(workflowViewSchema.safeParse({ ...view, ...delta }).success).toBe(false);
  }
  for (const delta of [{ manageableConnectionIds: ["unknown"] }, { manageableConnectionIds: [connection.connectionId, connection.connectionId] },
    { connectionReconciliationRequired: true }]) expect(workflowViewSchema.safeParse({ ...view, ...delta }).success).toBe(false);
  expect(workflowViewSchema.safeParse({ ...view, usableConnectionId: undefined, assetReadAccount: undefined }).success).toBe(true);
});

it("requires multiple distinct targets for a connection conflict and excludes private session data", () => {
  const conflict = { reason: "multiple_connections", connectionIds: ["connection-a", "connection-b"] };
  expect(connectionConflictSchema.parse(conflict)).toEqual(conflict);
  for (const delta of [{ reason: "sdk_failure" }, { connectionIds: [] }, { connectionIds: ["connection-a"] },
    { connectionIds: ["connection-a", "connection-a"] }, { connectionIds: ["", "connection-b"] }, { topic: "private" }]) {
    expect(connectionConflictSchema.safeParse({ ...conflict, ...delta }).success).toBe(false);
  }
});
