import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  InMemoryLocalTransactionMaterialStore,
  LocalTransactionMaterialStoreError,
  verifyLocalTransactionMaterialArtifacts,
  localTransactionMaterialHandleSchema,
  type LocalTransactionMaterialStore
} from "../src/core/session/transactionMaterialStore.js";
import { SqliteTransactionMaterialStore } from "../src/core/session/sqliteTransactionMaterialStore.js";
import {
  configureDatabase,
  initializeDatabase
} from "../src/core/activity/sqliteActivityStoreSchema.js";
import { recordTestTransactionMaterial } from "./fixtures/transactionMaterial.js";

const account = `0x${"a".repeat(64)}`;

// The same contract must hold for both backends; the SQLite case also exercises the
// BLOB round-trip the digest-binding invariant depends on.
const stores: Array<[string, () => LocalTransactionMaterialStore]> = [
  ["in-memory", () => new InMemoryLocalTransactionMaterialStore()],
  [
    "sqlite",
    () => {
      const db = new Database(":memory:");
      configureDatabase(db);
      initializeDatabase(db);
      return new SqliteTransactionMaterialStore(db);
    }
  ]
];

describe.each(stores)("local transaction material store (%s)", (_label, makeStore) => {
  it("stores transaction bytes behind a redacted handle", () => {
    const store = makeStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = store.recordTransactionMaterial(
      {
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: bytes,
        expiresAt: new Date("2026-06-06T00:30:00.000Z"),
        redactedDiagnostics: { commandCount: 3 }
      },
      new Date("2026-06-06T00:00:00.000Z")
    );

    expect(handle).toMatchObject({
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      kind: "deepbook_swap_transaction_data",
      source: "sui_mcp_built",
      createdAt: "2026-06-06T00:00:00.000Z"
    });
    expect(() => localTransactionMaterialHandleSchema.parse({ ...handle, source: "say_ur_intent_built" })).toThrow(/source/);
    expect(handle).not.toHaveProperty("transactionBytes");
    expect(handle).not.toHaveProperty("redactedDiagnostics");

    bytes[0] = 9;
    const stored = store.getTransactionMaterial(handle, new Date("2026-06-06T00:00:01.000Z"));
    expect(stored?.transactionBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(stored?.redactedDiagnostics).toEqual({ commandCount: 3 });

    stored!.transactionBytes[1] = 8;
    expect(store.getTransactionMaterial(handle, new Date("2026-06-06T00:00:01.000Z"))?.transactionBytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("requires the full handle identity before returning local bytes", () => {
    const store = makeStore();
    const handle = store.recordTransactionMaterial(
      {
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: new Uint8Array([1]),
        expiresAt: new Date("2026-06-06T00:30:00.000Z")
      },
      new Date("2026-06-06T00:00:00.000Z")
    );

    const beforeExpiry = new Date("2026-06-06T00:00:01.000Z");
    expect(store.getTransactionMaterial(handle, beforeExpiry)).toBeDefined();
    expect(store.getTransactionMaterial({ ...handle, planId: "other_plan" }, beforeExpiry)).toBeUndefined();
    expect(store.getTransactionMaterial({ ...handle, reviewSessionId: "other_review" }, beforeExpiry)).toBeUndefined();
    expect(store.getTransactionMaterial({ ...handle, account: `0x${"b".repeat(64)}` }, beforeExpiry)).toBeUndefined();
  });

  it("expires and deletes local transaction material records", () => {
    const store = makeStore();
    const handle = store.recordTransactionMaterial(
      {
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: new Uint8Array([1]),
        expiresAt: new Date("2026-06-06T00:00:10.000Z")
      },
      new Date("2026-06-06T00:00:00.000Z")
    );

    expect(store.getTransactionMaterial(handle, new Date("2026-06-06T00:00:09.000Z"))).toBeDefined();
    expect(store.getTransactionMaterial(handle, new Date("2026-06-06T00:00:10.000Z"))).toBeUndefined();

    const secondHandle = store.recordTransactionMaterial(
      {
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: new Uint8Array([2]),
        expiresAt: new Date("2026-06-06T00:30:00.000Z")
      },
      new Date("2026-06-06T00:00:00.000Z")
    );
    store.deleteReviewSessionTransactionMaterials("review_1");
    expect(store.getTransactionMaterial(secondHandle)).toBeUndefined();
  });

  it("rejects invalid material records", () => {
    const store = makeStore();
    expect(() =>
      store.recordTransactionMaterial({
        reviewSessionId: "review_1",
        planId: "plan_1",
        account: "not-an-address",
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: new Uint8Array([1]),
        expiresAt: new Date("2026-06-06T00:30:00.000Z")
      })
    ).toThrow(LocalTransactionMaterialStoreError);

    expect(() =>
      store.recordTransactionMaterial({
        reviewSessionId: "review_1",
        planId: "plan_1",
        account,
        kind: "deepbook_swap_transaction_data",
        source: "sui_mcp_built",
        transactionBytes: new Uint8Array([]),
        expiresAt: new Date("2026-06-06T00:30:00.000Z")
      })
    ).toThrow(LocalTransactionMaterialStoreError);

    expect(() =>
      store.recordTransactionMaterial(
        {
          reviewSessionId: "review_1",
          planId: "plan_1",
          account,
          kind: "deepbook_swap_transaction_data",
          source: "sui_mcp_built",
          transactionBytes: new Uint8Array([1]),
          expiresAt: new Date("2026-06-06T00:00:00.000Z")
        },
        new Date("2026-06-06T00:00:00.000Z")
      )
    ).toThrow(LocalTransactionMaterialStoreError);
  });

  it("validates matching material handles and bytes-derived digest commitments as one artifact", async () => {
    const store = makeStore();
    const { handle, digest } = await recordTestTransactionMaterial({
      materialStore: store,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });

    expect(
      await verifyLocalTransactionMaterialArtifacts(
        {
          materialStore: store,
          transactionMaterial: handle,
          transactionMaterialDigest: { ...digest, account: digest.account.toUpperCase() },
          now: new Date("2026-06-06T00:00:02.000Z")
        },
      )
    ).toMatchObject({
      transactionMaterial: { materialId: handle.materialId, account },
      transactionMaterialDigest: { materialId: handle.materialId, account }
    });
  });

  it("rejects invalid digest commitments and stale artifact timestamps", async () => {
    const store = makeStore();
    const { handle, digest } = await recordTestTransactionMaterial({
      materialStore: store,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });

    await expect(
      verifyLocalTransactionMaterialArtifacts(
        {
          materialStore: store,
          transactionMaterial: handle,
          transactionMaterialDigest: { ...digest, transactionDigest: "not-a-digest" },
          now: new Date("2026-06-06T00:00:02.000Z")
        }
      )
    ).rejects.toThrow();
    await expect(
      verifyLocalTransactionMaterialArtifacts(
        {
          materialStore: store,
          transactionMaterial: handle,
          transactionMaterialDigest: { ...digest, computedAt: "2026-06-06T00:31:00.000Z" },
          now: new Date("2026-06-06T00:00:02.000Z")
        }
      )
    ).rejects.toThrow(LocalTransactionMaterialStoreError);
    await expect(
      verifyLocalTransactionMaterialArtifacts(
        {
          materialStore: store,
          transactionMaterial: handle,
          transactionMaterialDigest: digest,
          now: new Date("2026-06-06T00:30:00.000Z")
        }
      )
    ).rejects.toThrow(LocalTransactionMaterialStoreError);
  });

  it("rejects digest commitments derived from different stored bytes", async () => {
    const store = makeStore();
    const first = await recordTestTransactionMaterial({
      materialStore: store,
      reviewSessionId: "review_1",
      planId: "plan_1",
      account,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });
    const second = await recordTestTransactionMaterial({
      materialStore: store,
      reviewSessionId: "review_2",
      planId: "plan_2",
      account: `0x${"c".repeat(64)}`,
      now: new Date("2026-06-06T00:00:00.000Z"),
      computedAt: new Date("2026-06-06T00:00:01.000Z"),
      expiresAt: new Date("2026-06-06T00:30:00.000Z")
    });

    await expect(
      verifyLocalTransactionMaterialArtifacts({
        materialStore: store,
        transactionMaterial: first.handle,
        transactionMaterialDigest: {
          ...first.digest,
          transactionDigest: second.digest.transactionDigest
        },
        now: new Date("2026-06-06T00:00:02.000Z")
      })
    ).rejects.toThrow(LocalTransactionMaterialStoreError);
  });
});
