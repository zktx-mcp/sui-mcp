import { seedCurrentReadAccount } from "./fixtures/readAccount.js";
import { Client } from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { type ClientCapabilities } from "@modelcontextprotocol/client";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { describe, expect, it, vi } from "vitest";
import { registerReadCards } from "../src/mcp-ui/tools.js";
import { createReadCardStore } from "../src/mcp-ui/readCards.js";
import { createDeepbookUsdcChartService } from "../src/core/read/deepbookUsdcChartService.js";
import { SqliteActivityStore } from "../src/core/activity/sqliteActivityStore.js";
import { validateSupportedAdapterLifecycle } from "../src/adapters/adapterLifecycleValidators.js";
import { CARD_METADATA_KEY, CARD_DISPLAY_METADATA_KEY, CARD_TOOLS, CARD_RESOURCE_PREFIX,
  cardReferenceSchema, cardSnapshotSchema, cardReceiptDisplaySchema } from "../src/mcp-ui/contracts.js";
import { chainReceiptDigest, otherChainReceiptDigest } from "./fixtures/chainReceipt.js";
import { cardReceiptTransaction } from "./fixtures/cardReceiptTransaction.js";
import { readPublicChainReceipt } from "../src/core/action/suiChainReceiptReader.js";
import type { AccountInventorySummary } from "../src/core/read/readServiceTypes.js";
import { receiptForCard } from "../src/mcp-ui/view/receiptData.js";

const account = `0x${"a".repeat(64)}`;
const fetchedAt = "2026-09-22T00:00:00.000Z";
const inventory: AccountInventorySummary = { status: "ok", account, fetchedAt, name: null, balances: [], nfts: [], objectGroups: [], scannedObjects: 0, objectsTruncated: false };
async function harness(ui: boolean, transaction = cardReceiptTransaction, peer?: { name: string; capabilities: ClientCapabilities }) {
  const directory = mkdtempSync(join(tmpdir(), "say-card-mcp-"));
  const activityStore = new SqliteActivityStore({ databasePath: join(directory, "state.sqlite"), validateAdapterLifecycle: validateSupportedAdapterLifecycle });
  const accountInputs: unknown[] = []; const receiptInputs: unknown[] = [];
  const chart = createDeepbookUsdcChartService();
  const cards = createReadCardStore({ chart, records: activityStore.createCardRecordStore(), ownerId: "owner", now: () => new Date(fetchedAt),
    readService: { summarizeAccountInventory: async (input) => { accountInputs.push(input); return inventory; } },
    publicChainReceiptReader: async (input) => {
      receiptInputs.push(input);
      if (input.digest === otherChainReceiptDigest) return { status: "not_found" };
      return readPublicChainReceipt({ network: "mainnet", expectedChainIdentifier: "mainnet-chain", client: { core: {
        async getChainIdentifier() { return { chainIdentifier: "mainnet-chain" }; },
        async getTransaction(options) { expect(options.digest).toBe(chainReceiptDigest); return { $kind: "Transaction", Transaction: transaction }; }
      } } }, input);
    }
  });
  const server = new McpServer({ name: "card-service-fixture", version: "1" });
  registerReadCards(server, { cards: { store: cards }, activityStore, logger: { error: vi.fn() } });
  const client = new Client({ name: peer?.name ?? "card-test-client", version: "1" }, { capabilities: peer?.capabilities ?? (ui ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, cards, activityStore, accountInputs, receiptInputs, close: async () => {
    await client.close(); await server.close(); cards.stop(); activityStore.close(); rmSync(directory, { recursive: true, force: true });
  } };
}
function snapshot(result: Awaited<ReturnType<Client["callTool"]>>) {
  const payload = result.structuredContent as { ok: boolean; data: unknown };
  expect(payload.ok).toBe(true); return cardSnapshotSchema.parse(payload.data);
}

describe("MCP read cards, persisted results and private display", () => {
  it("exposes only current app-only read/submit controls, without temporary diagnostic or opening tools", async () => {
    const context = await harness(true);
    try {
      const tools = (await context.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([CARD_TOOLS.read, CARD_TOOLS.submit]));
      expect(tools.find((tool) => tool.name === CARD_TOOLS.submit)?._meta).toMatchObject({ ui: { visibility: ["app"] } });
      for (const old of ["ui.open_card", "ui.close_card", "ui.record_card_diagnostics"]) expect(tools.some((tool) => tool.name === old)).toBe(false);
    } finally { await context.close(); }
  });
  it("requests missing input without a saved card, source access or UI permission", async () => {
    const context = await harness(true);
    try {
      for (const [name, kind, field] of [[CARD_TOOLS.account, "account", "account"], [CARD_TOOLS.receipt, "receipt", "digest"]]) {
        const response = await context.client.callTool({ name: name!, arguments: {} });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toMatchObject({ ok: true, data: { kind, field, status: "input_required" } });
        expect(response._meta).toBeUndefined();
        expect((response.content as Array<{ type: string }>).some((item) => item.type === "resource_link")).toBe(false);
      }
      expect(context.accountInputs).toEqual([]); expect(context.receiptInputs).toEqual([]);
    } finally { await context.close(); }
  });
  it("binds an explicit account before querying, regardless of stored read context", async () => {
    const context = await harness(true);
    try {
      await seedCurrentReadAccount(context.activityStore, `0x${"b".repeat(64)}`, new Date());
      const creating = await context.client.callTool({ name: CARD_TOOLS.account, arguments: { account } });
      const ref = cardReferenceSchema.parse(creating._meta?.[CARD_METADATA_KEY]);
      expect(snapshot(creating)).toMatchObject({ state: "closed", reason: "completed", input: { account }, data: inventory });
      for (let frame = 0; frame < 2; frame++) {
        expect(snapshot(await context.client.callTool({ name: CARD_TOOLS.read, arguments: ref }))).toMatchObject({ input: { account }, data: inventory });
      }
      const conflict = await context.client.callTool({ name: CARD_TOOLS.submit, arguments: { ...ref, revision: snapshot(creating).revision, input: { account: `0x${"b".repeat(64)}` } } });
      expect(conflict.isError).toBe(true);
      const denied = await context.client.callTool({ name: CARD_TOOLS.read, arguments: { ...ref, permission: "wrong" } });
      expect(denied.isError).toBe(true); expect(denied._meta).toBeUndefined();
      expect(context.accountInputs).toEqual([{ account }]);
      const saved = await context.client.readResource({ uri: `${CARD_RESOURCE_PREFIX}${ref.cardId}` });
      expect(JSON.stringify(saved)).not.toContain(ref.permission);
    } finally { await context.close(); }
  });
  it("preserves real reader Pure inputs and PTB privately while the Receipt view is simplified", async () => {
    const context = await harness(true);
    try {
      const creating = await context.client.callTool({ name: CARD_TOOLS.receipt, arguments: { digest: chainReceiptDigest } });
      const ref = cardReferenceSchema.parse(creating._meta?.[CARD_METADATA_KEY]);
      const response = creating;
      const result = snapshot(response);
      expect(result).toMatchObject({ state: "closed", reason: "completed", data: { status: "found", receipt: {
        txDigest: chainReceiptDigest, gas: { totalMist: "130" }, inputs: [{ index: 0, kind: "pure" }, { index: 1, kind: "pure" }]
      } } });
      const details = cardReceiptDisplaySchema.parse(response._meta?.[CARD_DISPLAY_METADATA_KEY]);
      expect(details.pureInputs).toEqual([{ index: 0, bytes: "0x00" }, { index: 1, bytes: "0x98c276f632000000" }]);
      expect(details.ptbGraph?.mermaid.text).toContain("flowchart LR");
      const receipt = receiptForCard(result, details);
      expect(receipt.inputs).toMatchObject([{ index: 0, kind: "pure", bytes: "0x00" }, { index: 1, kind: "pure", bytes: "0x98c276f632000000" }]);
      expect(receipt.ptbGraph).toEqual(details.ptbGraph);
      const saved = await context.client.readResource({ uri: `${CARD_RESOURCE_PREFIX}${result.cardId}` });
      const model = JSON.stringify({ content: response.content, structuredContent: response.structuredContent, saved });
      for (const forbidden of [ref.permission, "0x98c276f632000000", "mMJ29jIAAAA=", "fixture-signature-never-exposed", '"bytes"', "flowchart LR"]) expect(model).not.toContain(forbidden);
      const read = await context.client.callTool({ name: CARD_TOOLS.read, arguments: ref });
      expect(read._meta?.[CARD_DISPLAY_METADATA_KEY]).toEqual(details);
      expect(context.receiptInputs).toHaveLength(1);
      for (const change of [{ cardId: "wrong" }, { revision: details.revision + 1 }, { transactionDigest: otherChainReceiptDigest }]) {
        expect(() => receiptForCard(result, { ...details, ...change })).toThrow("do not match");
      }
      expect(receiptForCard(result).inputs.every((input) => input.bytes === undefined)).toBe(true);
      const denied = await context.client.callTool({ name: CARD_TOOLS.read, arguments: { ...ref, permission: "wrong" } });
      expect(denied._meta).toBeUndefined(); expect(JSON.stringify(denied)).not.toContain("0x98c276f632000000");
    } finally { await context.close(); }
  });
  it("rejects a well-formed source receipt for a different digest before storing UI details", async () => {
    const context = await harness(true, { ...cardReceiptTransaction, digest: otherChainReceiptDigest,
      effects: { ...cardReceiptTransaction.effects, transactionDigest: otherChainReceiptDigest } });
    try {
      const response = await context.client.callTool({ name: CARD_TOOLS.receipt, arguments: { digest: chainReceiptDigest } });
      const state = snapshot(response);
      expect(state).toMatchObject({ state: "closed", reason: "failed", input: { digest: chainReceiptDigest } });
      expect(state.data).toBeUndefined();
      expect(response._meta?.[CARD_DISPLAY_METADATA_KEY]).toBeUndefined();
      const saved = await context.client.readResource({ uri: `${CARD_RESOURCE_PREFIX}${state.cardId}` });
      expect(JSON.stringify(saved)).not.toContain(otherChainReceiptDigest);
      expect(context.receiptInputs).toHaveLength(1);
    } finally { await context.close(); }
  });
  it("keeps not-found results distinct and rejects invalid digests before source access", async () => {
    const context = await harness(true);
    try {
      expect(snapshot(await context.client.callTool({ name: CARD_TOOLS.receipt, arguments: { digest: otherChainReceiptDigest } })).data).toEqual({ status: "not_found" });
      expect((await context.client.callTool({ name: CARD_TOOLS.receipt, arguments: { digest: "bad" } })).isError).toBe(true);
      expect(context.receiptInputs).toHaveLength(1);
    } finally { await context.close(); }
  });
  it("does not create UI permission or call the source for an ordinary MCP client", async () => {
    const context = await harness(false);
    try {
      const result = await context.client.callTool({ name: CARD_TOOLS.account, arguments: { account } });
      expect(result.isError).toBe(true); expect(result._meta).toBeUndefined();
      expect(JSON.stringify(result.content)).toContain("ui_unavailable"); expect(context.accountInputs).toEqual([]);
    } finally { await context.close(); }
  });
});


it.each(["codex-mcp-client", "claude-ai", "Arbitrary standard client"])(
  "uses the same per-connection UI contract for read-card admission (%s)", async (name) => {
    for (const advertised of [true, false]) {
      const context = await harness(false, cardReceiptTransaction, { name,
        capabilities: advertised ? { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE, "text/html+skybridge"] } } } : {} });
      try {
        const create = vi.spyOn(context.cards, "create");
        const response = CallToolResultSchema.parse(await context.client.callTool({ name: CARD_TOOLS.account, arguments: { account } }));
        if (advertised) {
          expect(snapshot(response)).toMatchObject({ kind: "account", input: { account }, state: "closed", reason: "completed" });
          expect(cardReferenceSchema.parse(response._meta?.[CARD_METADATA_KEY]).cardId).toBe(snapshot(response).cardId);
          expect(create).toHaveBeenCalledOnce(); expect(context.accountInputs).toHaveLength(1);
        } else {
          expect(response.isError).toBe(true);
          const text = response.content.find((item) => item.type === "text");
          expect(JSON.parse(text?.type === "text" ? text.text : "null")).toMatchObject({ ok: false, error: { kind: "ui_unavailable" } });
          expect(response._meta).toBeUndefined(); expect(create).not.toHaveBeenCalled();
          expect(context.accountInputs).toHaveLength(0); expect(context.receiptInputs).toHaveLength(0);
        }
      } finally { await context.close(); }
    }
  }
);

it.each([
  {}, { mimeTypes: [] }, { mimeTypes: ["text/html+skybridge"] },
  { mimeTypes: RESOURCE_MIME_TYPE }, { mimeTypes: [RESOURCE_MIME_TYPE, 1] }
])("rejects absent, nonstandard or malformed UI MIME advertisements before card/source access (%j)", async (ui) => {
  const context = await harness(false, cardReceiptTransaction, { name: "codex-mcp-client", capabilities: { extensions: { [EXTENSION_ID]: ui } } });
  try {
    const create = vi.spyOn(context.cards, "create");
    const response = CallToolResultSchema.parse(await context.client.callTool({ name: CARD_TOOLS.receipt, arguments: { digest: chainReceiptDigest } }));
    expect(response.isError).toBe(true); expect(response._meta).toBeUndefined();
    const text = response.content.find((item) => item.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "null")).toMatchObject({ error: { kind: "ui_unavailable" } });
    expect(create).not.toHaveBeenCalled(); expect(context.receiptInputs).toHaveLength(0);
  } finally { await context.close(); }
});
