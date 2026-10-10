import fs from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { deferred } from "./fixtures/walletWorkflow.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";

const resources: Awaited<ReturnType<typeof settingsWorkflowFixture>>[] = [];
afterEach(async () => { for (const f of resources.splice(0).reverse()) await f.close(); });
async function fixture() { const f = await settingsWorkflowFixture(); resources.push(f); return f; }
const view = (value: { snapshot: { data?: unknown } }) => value.snapshot.data as SettingsView;
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const card = await f.create(), input = { action: "settings_download_backup", operationId: view(card).operationId, attemptId: randomUUID() };
  const accepted = await f.act(card, input);
  expect(accepted.error).toBeUndefined();
  return { card, input, accepted };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>, card: Awaited<ReturnType<typeof f.create>>) {
  let current = await f.read(card);
  await vi.waitFor(async () => { current = await f.read(card); expect(view(current).download?.availability).toBe("available"); });
  return current;
}

it("admits one immutable snapshot and cleans only its private file after a scoped Host report", async () => {
  const f = await fixture(), write = vi.spyOn(f.files, "createDownload");
  const { card, input } = await start(f), current = await ready(f, card), data = view(current);
  expect(data.result).toMatchObject({ outcome: "completed", completionScope: "backup_snapshot" });
  expect(data.result?.details).not.toHaveProperty("path"); expect(data.backupLocation).toBeUndefined();
  expect(data.preparation).toBeUndefined(); expect(data.allowedActions).toEqual([]); expect(data.observe).toBe(false);
  expect(data.temporaryFileCleanup).toBeUndefined(); expect(write).toHaveBeenCalledOnce();
  expect(await f.act(card, input)).not.toHaveProperty("error"); expect(write).toHaveBeenCalledOnce();
  const file = data.file!, path = join(f.wallet.directory, ".settings-staging", file.fileId + ".download");
  const bytes = await readFile(path), backup = JSON.parse(bytes.toString("utf8"));
  expect(backup.network).toBe("mainnet"); expect(backup.data.accounts).toEqual([]);
  expect(backup.data.reviewRequests).toEqual([]); expect(backup.data.activeAccountContext).toEqual([]);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  expect(await readdir(join(f.wallet.directory, "backups")).catch(() => [])).toEqual([]);
  const response = await f.wallet.run(() => f.cards.readSettingsFile({ cardId: card.snapshot.cardId, permission: card.permission,
    operationId: data.operationId, fileId: file.fileId, offset: 0, attemptId: input.attemptId }, 32));
  expect(Buffer.from(response.chunkBase64, "base64")).toEqual(bytes.subarray(0, 32));
  const result = structuredClone(data.result);
  const report = { action: "settings_report_download", operationId: data.operationId, fileId: file.fileId, attemptId: input.attemptId, status: "acknowledged" };
  const reported = await f.act(current, report);
  expect(reported.error).toBeUndefined(); expect(view(reported).download).toMatchObject({ availability: "ended", endReason: "acknowledged", hostReport: "acknowledged" });
  expect(view(reported).result).toEqual(result); expect(view(reported).temporaryFileCleanup).toBe("complete");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.act(current, report)).error).toBeUndefined();
  expect((await f.act(reportedWithPermission(reported, card.permission), { ...report, status: "unconfirmed" })).error).toBeDefined();
  expect(write).toHaveBeenCalledOnce();
});
function reportedWithPermission<T extends { snapshot: unknown }>(value: T, permission: string) { return { ...value, permission }; }

it("keeps a late old report out of the current retry and never regenerates the snapshot", async () => {
  const f = await fixture(), write = vi.spyOn(f.files, "createDownload"), { card, input } = await start(f);
  let current = await ready(f, card); const data = view(current), fileId = data.file!.fileId, attemptId = randomUUID();
  const retry = { action: "settings_retry_download", operationId: data.operationId, fileId, previousAttemptId: input.attemptId, attemptId };
  const retried = await f.act(current, retry); expect(retried.error).toBeUndefined();
  current = { ...retried, permission: card.permission };
  const late = await f.act(current, { action: "settings_report_download", operationId: data.operationId, fileId,
    attemptId: input.attemptId, status: "acknowledged" });
  expect(late.error).toBeUndefined(); expect(view(late).download).toMatchObject({ availability: "available", currentAttemptId: attemptId });
  expect(view(late).download?.hostReport).toBeUndefined(); expect(view(late).result).toEqual(data.result);
  expect((await f.act(current, retry)).error).toBeUndefined(); expect(write).toHaveBeenCalledOnce();
  expect(view(await f.read(card)).download?.expiresAt).toBe(data.download?.expiresAt);
  await expect(readFile(join(f.wallet.directory, ".settings-staging", fileId + ".download"))).resolves.toBeInstanceOf(Buffer);
});

it.each([-1, 0, 1])("separates the original input deadline from the snapshot lease at its %d ms boundary", async (delta) => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), original = f.files.createDownload.bind(f.files);
  vi.spyOn(f.files, "createDownload").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
  const card = await f.create(); f.wallet.advance(30 * 60 * 1000 - 1);
  const input = { action: "settings_download_backup", operationId: view(card).operationId, attemptId: randomUUID() };
  try {
    expect((await f.act(card, input)).error).toBeUndefined(); await entered.promise;
    f.wallet.advance(60_000); const snapshotReadyAt = f.wallet.now().getTime(); release.resolve();
    const current = await ready(f, card), data = view(current);
    expect(data.download?.expiresAt).toBe(new Date(snapshotReadyAt + 1_800_000).toISOString());
    f.wallet.advance(1_800_000 + delta);
    const next = await f.read(card);
    expect(view(next).download?.availability).toBe(delta < 0 ? "available" : "ended");
    expect(view(next).result).toEqual(data.result);
    if (delta >= 0) {
      expect(view(next).download?.endReason).toBe("expired");
      await expect(f.wallet.run(() => f.cards.readSettingsFile({ cardId: card.snapshot.cardId, permission: card.permission,
        operationId: data.operationId, fileId: data.file!.fileId, attemptId: input.attemptId, offset: 0 }, 1))).rejects.toThrow();
      await expect(readFile(join(f.wallet.directory, ".settings-staging", data.file!.fileId + ".download"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally { release.resolve(); }
});

it("refuses the old new-export input while preserving the unchanged database schema", async () => {
  const f = await fixture(), before = f.wallet.run(() => f.records.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all());
  const card = await f.create();
  expect((await f.act(card, { action: "settings_select", draft: { kind: "export_local_data" } })).error).toBeDefined();
  const { card: download } = await start(f); await ready(f, download);
  expect(f.wallet.run(() => f.records.db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all())).toEqual(before);
  expect(await readdir(join(f.wallet.directory, "backups")).catch(() => [])).toEqual([]);
});

it("expires and removes an abandoned snapshot without a card read or application restart", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await fixture();
  try {
    const { card } = await start(f), current = await ready(f, card), data = view(current);
    const path = join(f.wallet.directory, ".settings-staging", `${data.file!.fileId}.download`);
    f.wallet.advance(1_800_000);
    await vi.advanceTimersByTimeAsync(1_800_000);
    // Read raw stored facts only; describe() cannot be the cleanup trigger.
    await vi.waitFor(() => expect(f.wallet.run(() => f.records.file(data.file!.fileId)?.cleanup)).toBe("complete"));
    expect(f.wallet.run(() => f.records.get(data.operationId)?.preparation?.download)).toMatchObject({ endReason: "expired" });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.wallet.run(() => f.records.get(data.operationId)?.result)).toEqual(data.result);
  } finally { vi.useRealTimers(); }
});

it("does not delete a pre-existing item after exclusive snapshot creation refuses its path", async () => {
  const f = await fixture(), create = f.files.createDownload.bind(f.files), marker = Buffer.from("existing item");
  let path = "";
  vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (file, bytes) => {
    await mkdir(join(f.wallet.directory, ".settings-staging"), { recursive: true });
    path = join(f.wallet.directory, file.relativePath); await writeFile(path, marker, { flag: "wx" });
    return create(file, bytes);
  });
  const { card } = await start(f);
  await vi.waitFor(async () => expect(view(await f.read(card)).result?.outcome).toBe("failed"));
  expect(await readFile(path)).toEqual(marker);
  const state = view(await f.read(card));
  expect(state.download).toMatchObject({ availability: "ended", endReason: "source_unavailable" });
  expect(state.temporaryFileCleanup).toBe("complete");
});

it("keeps the stored snapshot readable and input closed when persisting expiry fails", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  f.wallet.run(() => f.records.db.exec(`CREATE TRIGGER refuse_download_expiry BEFORE UPDATE OF preparation_json ON settings_operations
    WHEN OLD.operation_id='${data.operationId}' BEGIN SELECT RAISE(ABORT,'download expiry refused'); END`));
  try {
    f.wallet.advance(1_800_000);
    const expired = await f.read(card);
    expect(view(expired).result).toEqual(data.result);
    expect(view(expired).download).toMatchObject({ availability: "ended", endReason: "expired", remainingMs: 0 });
    expect(view(expired).download?.allowedFileActions).not.toContain("settings_retry_download");
    expect(view(expired).temporaryFileCleanup).toBe("pending");
    const unrelated = await f.create(); expect(unrelated.error).toBeUndefined();
  } finally { f.wallet.run(() => f.records.db.exec("DROP TRIGGER refuse_download_expiry")); }
  const settled = await f.read(card);
  expect(view(settled).result).toEqual(data.result); expect(view(settled).temporaryFileCleanup).toBe("complete");
});

it.each(["cancel", "replacement"] as const)("keeps the actual descriptor alive through %s and its result readable during cleanup", async (mode) => {
  const f = await fixture(), { card, input } = await start(f), current = await ready(f, card), data = view(current);
  const path = join(f.wallet.directory, ".settings-staging", `${data.file!.fileId}.download`);
  const entered = deferred<void>(), release = deferred<void>();
  const originalOpen = fs.open; let descriptorClosed = false;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === path && typeof args[1] === "number" && !(args[1] & (constants.O_RDWR | constants.O_WRONLY))) {
      const stream = handle.createReadStream.bind(handle), close = handle.close.bind(handle);
      handle.close = async () => { await close(); descriptorClosed = true; };
      handle.createReadStream = ((options) => {
        const actual = stream(options);
        // The real descriptor, stream and product hash loop remain in use.
        // Only external I/O completion is held before yielding the real bytes.
        return { async *[Symbol.asyncIterator]() { entered.resolve(); await release.promise; for await (const part of actual) yield part; } } as ReturnType<typeof stream>;
      }) as typeof handle.createReadStream;
    }
    return handle;
  };
  syncBuiltinESMExports();
  let reading: Promise<unknown> | undefined, ending: Promise<unknown> | undefined;
  let resultCard = current;
  try {
    reading = f.wallet.run(() => f.cards.readSettingsFile({ cardId: card.snapshot.cardId, permission: card.permission,
      operationId: data.operationId, fileId: data.file!.fileId, attemptId: input.attemptId, offset: 0 }, 32));
    const refused = expect(reading).rejects.toThrow();
    await entered.promise;
    if (mode === "cancel") ending = f.act(current, { action: "settings_cancel_download", operationId: data.operationId, fileId: data.file!.fileId, attemptId: input.attemptId });
    else { resultCard = await f.prepare({ kind: "reset_local_data" }); ending = f.confirm(resultCard); }
    await vi.waitFor(() => expect(f.wallet.run(() => f.records.file(data.file!.fileId)?.invalidated)).toBe(true));
    expect(descriptorClosed).toBe(false); expect((await readFile(path)).length).toBe(data.file!.totalSize);
    const saved = await f.read(resultCard);
    if (mode === "cancel") expect(view(saved).result).toEqual(data.result);
    else {
      expect(view(saved).result).toMatchObject({ outcome: "completed", details: { status: "reset" } });
      expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(1);
      await expect(f.read(card)).rejects.toThrow("access is unavailable");
    }
    expect(view(saved).temporaryFileCleanup).toBe("pending");
    expect(descriptorClosed).toBe(false);
    release.resolve(); await refused; await ending;
    expect(descriptorClosed).toBe(true);
    await vi.waitFor(async () => expect(view(await f.read(resultCard)).temporaryFileCleanup).toBe("complete"));
    expect(view(await f.read(resultCard)).result).toEqual(view(saved).result);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release.resolve(); await Promise.allSettled([reading, ending].filter((task): task is Promise<unknown> => !!task));
    fs.open = originalOpen; syncBuiltinESMExports();
  }
});

it("rejects cross-card continuations before settling the target snapshot's expiry", async () => {
  const f = await fixture(), { card, input } = await start(f), current = await ready(f, card), data = view(current);
  const before = f.wallet.run(() => ({ operation: f.records.get(data.operationId), file: f.records.file(data.file!.fileId) }));
  // The target is due, but no owner timer or target read runs in this fixture.
  // A fresh, valid other card must not become authority to settle that target.
  f.wallet.advance(1_800_001); const other = await f.create();
  const response = await f.act(other, { action: "settings_report_download", operationId: data.operationId,
    fileId: data.file!.fileId, attemptId: input.attemptId, status: "acknowledged" });
  expect(response.error?.code).toBe("card_conflict");
  expect(f.wallet.run(() => ({ operation: f.records.get(data.operationId), file: f.records.file(data.file!.fileId) }))).toEqual(before);
});

it.each(["settings_retry_download", "settings_report_download", "settings_cancel_download"] as const)(
  "keeps %s bound to its card, file and admitted attempt", async (action) => {
    const f = await fixture(), { card, input } = await start(f), current = await ready(f, card), data = view(current);
    const before = f.wallet.run(() => ({ operation: f.records.get(data.operationId), file: f.records.file(data.file!.fileId), control: f.records.control() }));
    const base = action === "settings_retry_download"
      ? { action, operationId: data.operationId, fileId: data.file!.fileId, previousAttemptId: input.attemptId, attemptId: randomUUID() }
      : { action, operationId: data.operationId, fileId: data.file!.fileId, attemptId: input.attemptId,
        ...(action === "settings_report_download" ? { status: "acknowledged" } : {}) };
    for (const bad of [{ ...base, operationId: randomUUID() }, { ...base, fileId: randomUUID() },
      action === "settings_retry_download" ? { ...base, previousAttemptId: randomUUID() } : { ...base, attemptId: randomUUID() }]) {
      expect((await f.act(current, bad)).error?.code).toBe("card_conflict");
      expect(f.wallet.run(() => ({ operation: f.records.get(data.operationId), file: f.records.file(data.file!.fileId), control: f.records.control() }))).toEqual(before);
    }
    await expect(f.wallet.run(() => f.cards.act({ cardId: card.snapshot.cardId, permission: "wrong-permission",
      revision: current.snapshot.revision, input: base }))).rejects.toThrow("Card access is unavailable");
    await expect(f.wallet.run(() => f.cards.readSettingsFile({ cardId: card.snapshot.cardId, permission: card.permission,
      operationId: data.operationId, fileId: data.file!.fileId, offset: 0, attemptId: randomUUID() }, 1))).rejects.toThrow("attempt changed");
    expect((await f.act(current, base)).error).toBeUndefined();
  });
