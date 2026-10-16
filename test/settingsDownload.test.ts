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

async function status(f: Awaited<ReturnType<typeof fixture>>, card: Awaited<ReturnType<typeof f.create>>) {
  return f.create({ operationStatus: { operationId: view(card).operationId } });
}
async function delivery(f: Awaited<ReturnType<typeof fixture>>, data: SettingsView) {
  return f.create({ backupDelivery: { operationId: data.operationId, fileId: data.file!.fileId } });
}

it("admits one immutable snapshot and cleans only its private file after a scoped Host report", async () => {
  const f = await fixture(), write = vi.spyOn(f.files, "createDownload");
  const { card, input } = await start(f), current = await ready(f, card), data = view(current);
  expect(data.result).toBeUndefined(); expect(current.snapshot.state).toBe("running");
  expect(data).not.toHaveProperty("result"); expect(data.backupLocation).toBeUndefined();
  expect(data.preparation).toBeUndefined(); expect(data.allowedActions).toEqual([]); expect(data.observe).toBe(false);
  expect(data.temporaryFileCleanup).toBeUndefined(); expect(write).toHaveBeenCalledOnce();
  expect(await f.act(card, input)).not.toHaveProperty("error"); expect(write).toHaveBeenCalledOnce();
  const file = data.file!, path = join(f.wallet.directory, ".settings-staging", file.fileId + ".download");
  const bytes = await readFile(path), backup = JSON.parse(bytes.toString("utf8"));
  expect(backup.network).toBe("mainnet"); expect(backup.data.accounts).toEqual([]);
  expect(backup.data.reviewRequests).toEqual([]); expect(backup.data).not.toHaveProperty("chainAccountContexts");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
  expect(await readdir(join(f.wallet.directory, "backups")).catch(() => [])).toEqual([]);
  const response = await f.wallet.run(() => f.cards.readSettingsFile({ cardId: card.snapshot.cardId, permission: card.permission,
    operationId: data.operationId, fileId: file.fileId, offset: 0, attemptId: input.attemptId }, 32));
  expect(Buffer.from(response.chunkBase64, "base64")).toEqual(bytes.subarray(0, 32));
  const report = { action: "settings_report_download", operationId: data.operationId, fileId: file.fileId, attemptId: input.attemptId, status: "acknowledged" };
  const reported = await f.act(current, report);
  expect(reported.error).toBeUndefined(); expect(view(reported).download).toMatchObject({ availability: "ended", endReason: "acknowledged", hostReport: "acknowledged" });
  expect(view(reported).result).toMatchObject({ outcome: "completed", completionScope: "backup_delivery" });
  expect(view(await status(f, card)).temporaryFileCleanup).toBe("complete");
  expect((await f.read(card)).snapshot).toEqual(reported.snapshot);
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
  const retryCard = await delivery(f, data);
  const retried = await f.act(retryCard, retry); expect(retried.error).toBeUndefined();
  current = { ...retried, permission: retryCard.permission };
  const frozen = (await f.read(card)).snapshot;
  const late = await f.act(card, { action: "settings_report_download", operationId: data.operationId, fileId,
    attemptId: input.attemptId, status: "acknowledged" });
  expect(late.error).toBeUndefined(); expect(late.snapshot).toEqual(frozen);
  expect(view(await f.read(current)).download).toMatchObject({ availability: "available", currentAttemptId: attemptId });
  expect(view(await f.read(current)).download?.hostReport).toBeUndefined();
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
    if (delta < 0) expect(view(next).result).toBeUndefined(); else expect(view(next).result).toMatchObject({ outcome: "failed", completionScope: "backup_delivery" });
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
  expect((await f.act(card, { action: "settings_select", draft: { kind: "unsupported_operation" } })).error).toBeDefined();
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
    expect(f.wallet.run(() => f.records.get(data.operationId)?.result)).toMatchObject({ outcome: "failed" });
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
  expect(view(await status(f, card)).temporaryFileCleanup).toBe("complete");
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
    expect(view(expired).file?.cleanup).toBe("pending"); expect(expired.snapshot.state).toBe("running");
    const unrelated = await f.create(); expect(unrelated.error).toBeUndefined();
  } finally { f.wallet.run(() => f.records.db.exec("DROP TRIGGER refuse_download_expiry")); }
  const settled = await f.read(card);
  expect(view(settled).result).toMatchObject({ outcome: "failed", completionScope: "backup_delivery" });
  expect(view(await f.status(card)).temporaryFileCleanup).toBe("complete");
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
    if (mode === "cancel") expect(view(saved).result).toMatchObject({ outcome: "interrupted" });
    else {
      expect(view(saved).result).toMatchObject({ outcome: "completed", details: { status: "reset" } });
      expect(f.wallet.run(() => f.records.control().data_epoch)).toBe(1);
      await expect(f.read(card)).rejects.toThrow("access is unavailable");
    }
    expect(view(saved).temporaryFileCleanup).toBe("pending");
    expect(descriptorClosed).toBe(false);
    release.resolve(); await refused; await ending;
    expect(descriptorClosed).toBe(true);
    await vi.waitFor(async () => expect(view(await status(f, resultCard)).temporaryFileCleanup).toBe("complete"));
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
    if (action === "settings_retry_download") {
      expect((await f.act(current, base)).error).toBeDefined();
      expect((await f.act(await delivery(f, data), base)).error).toBeUndefined();
    } else expect((await f.act(current, base)).error).toBeUndefined();
  });

const unsupportedFailure = { method: "ui/download-file", code: -32601 };
function unsupportedReport(data: SettingsView) {
  return { action: "settings_report_download", operationId: data.operationId, fileId: data.file!.fileId,
    attemptId: data.download!.currentAttemptId, status: "unsupported", failure: unsupportedFailure };
}
async function localResult(f: Awaited<ReturnType<typeof fixture>>, card: Awaited<ReturnType<typeof f.create>>, status: "saved" | "failed" | "needs_consent") {
  let current = await f.read(card);
  await vi.waitFor(async () => { current = await f.read(card); expect(view(current).download?.localSave?.status).toBe(status); });
  return current;
}

it("publishes the same verified inode once only after this scoped download is reported unsupported", async () => {
  const f = await fixture(), publication = vi.spyOn(f.files, "publishDownload"), { card } = await start(f);
  const current = await ready(f, card), data = view(current), report = unsupportedReport(data);
  const stage = join(f.wallet.directory, ".settings-staging", `${data.file!.fileId}.download`), bytes = await readFile(stage), identity = await fs.stat(stage);
  expect(f.wallet.run(() => f.records.get(data.operationId)?.result)).toBeUndefined();
  expect((await f.act(current, report)).error).toBeUndefined();
  const saved = view(await localResult(f, card, "saved")), path = join(f.wallet.directory, "backups", `${data.operationId}.json`);
  await vi.waitFor(async () => expect(view(await status(f, card)).temporaryFileCleanup).toBe("complete"));
  expect(await readFile(path)).toEqual(bytes); expect((await fs.stat(path)).ino).toBe(identity.ino);
  expect(saved.backupLocation).toEqual({ directory: join(f.wallet.directory, "backups"), filename: `${data.operationId}.json` });
  expect(saved.download).toMatchObject({ availability: "ended", endReason: "stored_locally" });
  expect(saved.allowedActions).toEqual([]); expect(saved.observe).toBe(false); expect(saved.preparation).toBeUndefined();
  expect(f.wallet.run(() => f.records.get(data.operationId)?.result)).toMatchObject({ outcome: "completed", completionScope: "backup_delivery" });
  expect((await f.act(current, report)).error).toBeUndefined(); expect(publication).toHaveBeenCalledOnce();
  expect((await f.act(current, { ...report, failure: { method: "ui/other", code: -32601 } })).error).toBeDefined();
  expect(await readdir(join(f.wallet.directory, "backups"))).toEqual([`${data.operationId}.json`]);
  await expect(readFile(stage)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.wallet.run(() => f.cards.readSettingsFile({ cardId: card.snapshot.cardId, permission: card.permission,
    operationId: data.operationId, fileId: data.file!.fileId, attemptId: data.download!.currentAttemptId, offset: 0 }, 1))).rejects.toThrow();
  const reset = await f.prepare({ kind: "reset_local_data" }); expect((await f.confirm(reset)).error).toBeUndefined();
  expect(await readFile(path)).toEqual(bytes); expect(publication).toHaveBeenCalledOnce();
});

it.each(["unconfirmed", "not_completed", "unreported"])("requires explicit local-copy consent after a prior %s attempt and preserves duplicate semantics", async (prior) => {
  const f = await fixture(), publication = vi.spyOn(f.files, "publishDownload"), { card, input } = await start(f);
  let current = await ready(f, card); const before = view(current);
  if (prior !== "unreported") await f.act(current, { ...unsupportedReport(before), status: prior, failure: undefined });
  const nextId = randomUUID();
  const retryCard = await delivery(f, before);
  expect((await f.act(retryCard, { action: "settings_retry_download", operationId: before.operationId, fileId: before.file!.fileId,
    previousAttemptId: input.attemptId, attemptId: nextId })).error).toBeUndefined();
  current = await f.read(retryCard); expect((await f.act(current, unsupportedReport(view(current)))).error).toBeUndefined();
  const consent = view(await localResult(f, retryCard, "needs_consent"));
  current = await delivery(f, consent);
  expect(publication).not.toHaveBeenCalled(); expect(consent.download?.allowedFileActions).not.toContain("settings_retry_download");
  const save = { action: "settings_store_backup", operationId: consent.operationId, fileId: consent.file!.fileId,
    attemptId: nextId, saveAttemptId: randomUUID(), allowPossibleCopy: true };
  expect((await f.act(current, { ...save, allowPossibleCopy: false })).error).toBeDefined();
  expect((await f.act(current, save)).error).toBeUndefined(); await localResult(f, current, "saved");
  expect((await f.act(current, save)).error).toBeUndefined();
  expect((await f.act(current, { ...save, allowPossibleCopy: false })).error).toBeDefined();
  expect(publication).toHaveBeenCalledOnce();
  const late = { ...unsupportedReport(before), status: "acknowledged", failure: undefined };
  if (prior === "unreported") expect((await f.act(card, late)).error).toBeUndefined();
  expect(view(await f.read(current)).download).toMatchObject({ endReason: "stored_locally", currentAttemptId: nextId });
});

it.each(["expired", "cancelled"])("records a late unsupported fact after %s without admitting a file effect", async (reason) => {
  const f = await fixture(), publication = vi.spyOn(f.files, "publishDownload"), { card } = await start(f);
  const current = await ready(f, card), data = view(current);
  if (reason === "expired") f.wallet.advance(1_800_000);
  else await f.act(current, { action: "settings_cancel_download", operationId: data.operationId, fileId: data.file!.fileId, attemptId: data.download!.currentAttemptId });
  const result = await f.act(current, unsupportedReport(data)); expect(result.error).toBeUndefined();
  expect(view(result).download).toMatchObject({ endReason: reason });
  expect(f.wallet.run(() => f.records.get(data.operationId)?.preparation?.download)).toMatchObject({ attempts: [expect.objectContaining({ hostReport: "unsupported" })] });
  expect(view(result).download?.localSave).toBeUndefined(); expect(publication).not.toHaveBeenCalled();
});

it.each(["different_inode", "symlink"])("preserves an existing %s target and does not call it this request's saved backup", async (mode) => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const stage = join(f.wallet.directory, ".settings-staging", `${data.file!.fileId}.download`), bytes = await readFile(stage);
  await mkdir(join(f.wallet.directory, "backups")); const path = join(f.wallet.directory, "backups", `${data.operationId}.json`);
  if (mode === "different_inode") await writeFile(path, bytes, { flag: "wx" }); else await fs.symlink(stage, path);
  const identity = await fs.lstat(path); await f.act(current, unsupportedReport(data));
  const result = view(await localResult(f, card, "failed"));
  expect(result.download).toMatchObject({ endReason: "local_save_failed", localSave: { failure: "target_conflict" } });
  expect(result.backupLocation).toBeUndefined(); expect(result.download?.allowedFileActions).not.toContain("settings_store_backup");
  expect((await fs.lstat(path)).ino).toBe(identity.ino);
  if (mode === "different_inode") expect(await readFile(path)).toEqual(bytes);
});

it("retains an admitted save through the lease deadline and refuses cancellation and data replacement until physical I/O ends", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const reset = await f.prepare({ kind: "reset_local_data" });
  const entered = deferred<void>(), release = deferred<void>(), original = fs.link;
  fs.link = async (...args) => { entered.resolve(); await release.promise; return original(...args); }; syncBuiltinESMExports();
  try {
    await f.act(current, unsupportedReport(data)); await entered.promise; f.wallet.advance(1_800_001);
    const busy = view(await f.read(card)); expect(busy.download).toMatchObject({ availability: "available", localSave: { status: "saving" } });
    expect(busy.download?.allowedFileActions).not.toContain("settings_cancel_download");
    expect((await f.act(current, { action: "settings_cancel_download", operationId: data.operationId, fileId: data.file!.fileId, attemptId: data.download!.currentAttemptId })).error).toBeDefined();
    expect((await f.confirm(reset)).error).toBeDefined();
    expect(f.wallet.run(() => f.records.control())).toMatchObject({ active_operation_id: data.operationId, file_io_id: data.file!.fileId, data_epoch: 0 });
    release.resolve(); const saved = view(await localResult(f, card, "saved")); expect(saved.download?.endReason).toBe("stored_locally");
    expect(saved.download?.expiresAt).toBe(data.download?.expiresAt);
  } finally { release.resolve(); fs.link = original; syncBuiltinESMExports(); }
});

it("retries only a proven absent publication using a new save ID and never regenerates its source", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const original = fs.link, snapshot = vi.spyOn(f.files, "createDownload"), publication = vi.spyOn(f.files, "publishDownload");
  fs.link = async () => { throw Object.assign(new Error("Synthetic filesystem link refusal"), { code: "EIO" }); }; syncBuiltinESMExports();
  try {
    await f.act(current, unsupportedReport(data)); const failed = view(await localResult(f, card, "failed"));
    expect(failed.download?.localSave?.failure).toBe("not_published"); expect(failed.download?.allowedFileActions).toEqual([]);
    await f.act(current, unsupportedReport(data)); expect(publication).toHaveBeenCalledOnce();
    fs.link = original; syncBuiltinESMExports();
    const retry = { action: "settings_store_backup", operationId: data.operationId, fileId: data.file!.fileId, attemptId: data.download!.currentAttemptId,
      previousSaveAttemptId: failed.download!.localSave!.currentSaveAttemptId, saveAttemptId: randomUUID(), allowPossibleCopy: false };
    const retryCard = await delivery(f, failed);
    expect((await f.act(retryCard, { ...retry, previousSaveAttemptId: randomUUID() })).error).toBeDefined();
    expect((await f.act(retryCard, retry)).error).toBeUndefined(); await localResult(f, retryCard, "saved");
    const currentStatus = await status(f, card), currentData = view(currentStatus);
    expect(currentData).toMatchObject({ phase: "terminal", result: { outcome: "completed", message: "Backup saved." },
      download: { endReason: "stored_locally", currentAttemptId: data.download!.currentAttemptId, localSave: { status: "saved" } },
      backupLocation: { directory: join(f.wallet.directory, "backups"), filename: `${data.operationId}.json` } });
    expect(Date.parse(currentData.result!.recordedAt)).toBeGreaterThanOrEqual(Date.parse(currentStatus.snapshot.createdAt));
    expect(currentData.file!.sha256).toBe(data.file!.sha256);
    expect(createHash("sha256").update(await readFile(join(f.wallet.directory, "backups", `${data.operationId}.json`))).digest("hex")).toBe(data.file!.sha256);
    expect(view(await f.read(card)).result).toEqual(failed.result);
    expect((await f.act(retryCard, retry)).error).toBeUndefined(); expect(publication).toHaveBeenCalledTimes(2); expect(snapshot).not.toHaveBeenCalled();
  } finally { fs.link = original; syncBuiltinESMExports(); }
});

it("records current artifact expiry without changing an earlier unconfirmed-delivery result", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  await f.act(current, { action: "settings_report_download", operationId: data.operationId, fileId: data.file!.fileId,
    attemptId: data.download!.currentAttemptId, status: "unconfirmed" });
  const original = (await f.read(card)).snapshot;
  f.wallet.advance(Date.parse(data.download!.expiresAt!) - f.wallet.now().getTime());
  const ended = await status(f, card);
  expect(view(ended)).toMatchObject({ phase: "terminal", download: { availability: "ended", endReason: "expired", allowedFileActions: [] },
    result: { outcome: "failed", message: "This backup is no longer available for delivery. Ask in chat for a new Settings card to create a backup." } });
  await expect(delivery(f, data)).rejects.toThrow("no longer available");
  expect((await f.read(card)).snapshot).toEqual(original);
});

it("keeps a linked but unrecorded result unsettled and reuses its physical outcome after DB recovery", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const publication = vi.spyOn(f.files, "publishDownload");
  f.wallet.run(() => f.records.db.exec(`CREATE TRIGGER refuse_local_save BEFORE UPDATE OF preparation_json ON settings_operations
    WHEN NEW.operation_id='${data.operationId}' AND json_extract(NEW.preparation_json,'$.download.localSave.status')='saved'
    BEGIN SELECT RAISE(ABORT,'synthetic saved-result failure'); END`));
  try {
    await f.act(current, unsupportedReport(data)); const target = join(f.wallet.directory, "backups", `${data.operationId}.json`);
    await vi.waitFor(async () => expect((await readFile(target)).length).toBe(data.file!.totalSize));
    expect(view(await f.read(card)).download?.localSave?.status).toBe("saving");
    expect(view(await f.read(card)).download?.allowedFileActions).not.toContain("settings_store_backup");
    expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(data.file!.fileId);
    f.wallet.run(() => f.records.db.exec("DROP TRIGGER refuse_local_save"));
    await localResult(f, card, "saved"); expect(publication).toHaveBeenCalledOnce();
    expect(await readdir(join(f.wallet.directory, "backups"))).toEqual([`${data.operationId}.json`]);
  } finally { f.wallet.run(() => f.records.db.exec("DROP TRIGGER IF EXISTS refuse_local_save")); }
});

it("does not interpret an unreadable destination as absent or retry publication after uncertain physical completion", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const path = join(f.wallet.directory, "backups", `${data.operationId}.json`), publication = vi.spyOn(f.files, "publishDownload");
  const original = fs.open;
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === path) throw Object.assign(new Error("Synthetic destination permission denial"), { code: "EACCES" });
    return original(...args);
  }; syncBuiltinESMExports();
  try {
    await f.act(current, unsupportedReport(data)); await vi.waitFor(async () => expect((await fs.stat(path)).size).toBe(data.file!.totalSize));
    const pending = view(await f.read(card));
    expect(pending.download?.localSave?.status).toBe("saving"); expect(pending.backupLocation).toBeUndefined();
    expect(pending.download?.allowedFileActions).not.toContain("settings_store_backup");
    expect(f.wallet.run(() => f.records.control().file_io_id)).toBe(data.file!.fileId);
    fs.open = original; syncBuiltinESMExports(); await localResult(f, card, "saved");
    expect(publication).toHaveBeenCalledOnce();
  } finally { fs.open = original; syncBuiltinESMExports(); }
});

it("preserves the verified local artifact and its result when private unlink fails", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current), publication = vi.spyOn(f.files, "publishDownload");
  const stage = join(f.wallet.directory, ".settings-staging", `${data.file!.fileId}.download`), original = fs.unlink;
  fs.unlink = async (...args) => { if (String(args[0]) === stage) throw Object.assign(new Error("Synthetic cleanup refusal"), { code: "EACCES" }); return original(...args); }; syncBuiltinESMExports();
  try {
    await f.act(current, unsupportedReport(data)); const saved = view(await localResult(f, card, "saved"));
    await vi.waitFor(async () => expect(view(await status(f, card)).temporaryFileCleanup).toBe("failed"));
    const path = join(saved.backupLocation!.directory, saved.backupLocation!.filename), bytes = await readFile(path);
    expect(bytes).toEqual(await readFile(stage)); expect(saved.download?.allowedFileActions).not.toContain("settings_store_backup");
    fs.unlink = original; syncBuiltinESMExports();
    await vi.waitFor(async () => expect(view(await status(f, card)).temporaryFileCleanup).toBe("complete"));
    expect(await readFile(path)).toEqual(bytes); expect(view(await f.read(card)).download?.localSave).toEqual(saved.download?.localSave);
    expect(publication).toHaveBeenCalledOnce();
  } finally { fs.unlink = original; syncBuiltinESMExports(); }
});

it("atomically refuses unsupported-report admission while another file owns the shared slot", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const entered = deferred<void>(), release = deferred<void>(), create = f.files.createDownload.bind(f.files);
  vi.spyOn(f.files, "createDownload").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return create(...args); });
  const publication = vi.spyOn(f.files, "publishDownload");
  let other: Awaited<ReturnType<typeof f.create>> | undefined;
  try {
    other = (await start(f)).card; await entered.promise;
    expect((await f.act(current, unsupportedReport(data))).error).toBeDefined();
    expect(view(await f.read(card)).download).not.toHaveProperty("localSave");
    expect(view(await f.read(card)).download?.hostReport).toBeUndefined(); expect(publication).not.toHaveBeenCalled();
    release.resolve(); await ready(f, other);
    expect((await f.act(current, unsupportedReport(data))).error).toBeUndefined();
    await localResult(f, card, "saved"); expect(publication).toHaveBeenCalledOnce();
  } finally { release.resolve(); if (other) await ready(f, other); }
});

it("awaits an admitted publication and its cleanup before closing without accepting more Settings input", async () => {
  const f = await fixture(), { card } = await start(f), current = await ready(f, card), data = view(current);
  const entered = deferred<void>(), release = deferred<void>(), original = fs.link;
  fs.link = async (...args) => { entered.resolve(); await release.promise; return original(...args); }; syncBuiltinESMExports();
  let closing: Promise<void> | undefined, closed = false;
  try {
    await f.act(current, unsupportedReport(data)); await entered.promise;
    closing = f.wallet.run(() => f.settings.close()).then(() => { closed = true; });
    const state = view(await f.read(card)); expect(state.download?.localSave?.status).toBe("saving"); expect(closed).toBe(false);
    expect((await f.act(current, { action: "settings_cancel_download", operationId: data.operationId, fileId: data.file!.fileId,
      attemptId: data.download!.currentAttemptId })).error).toBeDefined();
    release.resolve(); await closing;
    expect(view(await f.read(card)).download?.endReason).toBe("stored_locally");
    expect(view(await status(f, card)).temporaryFileCleanup).toBe("complete");
    expect((await readFile(join(f.wallet.directory, "backups", `${data.operationId}.json`))).length).toBe(data.file!.totalSize);
  } finally { release.resolve(); await closing; fs.link = original; syncBuiltinESMExports(); }
});


it("isolates valid cards sharing one artifact and reads current cleanup after a later delivery", async () => {
  const f = await fixture(), { card } = await start(f), initial = await ready(f, card), data = view(initial);
  await f.act(initial, { action: "settings_report_download", operationId: data.operationId, fileId: data.file!.fileId,
    attemptId: data.download!.currentAttemptId, status: "unconfirmed" });
  const original = (await f.read(card)).snapshot;
  expect(f.wallet.run(() => f.records.file(data.file!.fileId)?.invalidated)).toBe(false);
  expect(Date.parse(data.download!.expiresAt!)).toBeGreaterThan(f.wallet.now().getTime());
  expect(() => f.wallet.run(() => f.records.requireDownloadRead(f.records.cards.get(card.snapshot.cardId)!, data.file!.fileId,
    data.download!.currentAttemptId))).toThrow("attempt changed");
  const a = await delivery(f, data), b = await delivery(f, data), attemptId = randomUUID();
  expect((await f.act(a, { action: "settings_retry_download", operationId: data.operationId, fileId: data.file!.fileId,
    previousAttemptId: data.download!.currentAttemptId, attemptId })).error).toBeUndefined();
  const current = await f.read(a), context = f.wallet.run(() => f.records.cards.get(b.snapshot.cardId))!;
  expect(context.state.state).toBe("ready");
  expect(() => f.wallet.run(() => f.records.requireInput(context, data.operationId))).toThrow("Settings selection changed");
  expect(f.wallet.run(() => f.records.requireDownloadRead(f.records.cards.get(a.snapshot.cardId)!, data.file!.fileId, attemptId)).file.sha256).toBe(data.file!.sha256);
  expect(() => f.wallet.run(() => f.records.requireDownloadRead(context, data.file!.fileId, attemptId))).toThrow("attempt changed");
  expect(() => f.wallet.run(() => f.records.continueDownload(context, { action: "settings_report_download", operationId: data.operationId,
    fileId: data.file!.fileId, attemptId, status: "acknowledged" }))).toThrow("not admitted");
  expect(() => f.wallet.run(() => f.records.continueDownload(context, { action: "settings_cancel_download", operationId: data.operationId,
    fileId: data.file!.fileId, attemptId }))).toThrow("not admitted");
  expect(() => f.wallet.run(() => f.records.continueDownload(f.records.cards.get(a.snapshot.cardId)!, { action: "settings_retry_download",
    operationId: data.operationId, fileId: data.file!.fileId, previousAttemptId: attemptId, attemptId: randomUUID() }))).toThrow("retry");
  const cleanup = vi.spyOn(f.files, "cleanup").mockRejectedValue(new Error("Synthetic unlink failure"));
  try {
  await expect(f.act(current, { action: "settings_report_download", operationId: data.operationId, fileId: data.file!.fileId, attemptId, status: "acknowledged" })).rejects.toThrow("temporary files could not be removed");
  const ended = (await f.read(a)).snapshot;
  expect(ended.state).toBe("closed"); expect(f.wallet.run(() => f.records.file(data.file!.fileId)?.cleanup)).toBe("failed");
  const failed = await status(f, initial);
  expect(view(failed).temporaryFileCleanup).toBe("failed");
  cleanup.mockRestore();
  const completed = await status(f, initial);
  expect(view(completed).temporaryFileCleanup).toBe("complete");
  expect(view(failed).temporaryFileCleanup).toBe("failed");
  expect((await f.read(a)).snapshot).toEqual(ended); expect((await f.read(card)).snapshot).toEqual(original);
  expect(() => f.wallet.run(() => f.records.requireDownloadRead(f.records.cards.get(a.snapshot.cardId)!, data.file!.fileId, attemptId))).toThrow();
  } finally { cleanup.mockRestore(); }
});
