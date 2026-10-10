import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { downloadSettingsFile, type SettingsDownloadStatus } from "../src/mcp-ui/view/settingsFiles.js";
import type { SettingsViewTransport } from "../src/mcp-ui/view/lifecycle.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const clean of close.splice(0).reverse()) await clean(); });

it.each(["changed", "missing", "acknowledged", "not_completed", "unconfirmed"])("distinguishes backup verification from Host delivery (%s) and rereads the same file on retry", async (outcome) => {
  const f = await settingsWorkflowFixture(); close.push(f.close);
  const card = await f.create(); await f.download(card);
  let finished = await f.read(card);
  await vi.waitFor(async () => { finished = await f.read(card); expect((finished.snapshot.data as SettingsView).result?.outcome).toBe("completed"); });
  const view = finished.snapshot.data as SettingsView;
  const path = join(f.wallet.directory, ".settings-staging", `${view.file!.fileId}.download`), original = await readFile(path);
  const download = vi.fn(async (_name: string, _data: string) => {
    if (outcome === "unconfirmed") throw new Error("Host response unavailable");
    return { isError: outcome === "not_completed" };
  });
  if (outcome === "changed") await writeFile(path, Buffer.alloc(original.length, 1));
  if (outcome === "missing") await unlink(path);
  const statuses: SettingsDownloadStatus[] = [];
  const record = f.wallet.run(() => f.wallet.cardRecords.get(card.snapshot.cardId))!;
  const read = vi.fn(async (input: { fileId: string; offset: number; attemptId?: string | undefined }) => f.wallet.run(async () => {
    const range = await f.settings.readFile(record, input.fileId, input.offset, 32768, input.attemptId);
    return { ...range.file, cardId: card.snapshot.cardId, offset: range.offset, chunkBase64: range.chunkBase64 };
  }));
  const transport: SettingsViewTransport = { download, readFile: read,
    act: async () => { throw new Error("Download cannot apply Settings"); }, readCurrent: async () => ({ snapshot: finished.snapshot, requestStartedAt: performance.now() }),
    uploadChunkLimit: () => 1, setFileTransferActive() {} };
  const file = { operationId: view.operationId, fileId: view.file!.fileId, displayName: view.file!.displayName,
    totalSize: view.file!.totalSize, sha256: view.file!.sha256, attemptId: view.download!.currentAttemptId };
  await downloadSettingsFile(file, transport, (status) => statuses.push(status), () => true);
  expect(statuses).toEqual(["pending", outcome === "changed" || outcome === "missing" ? "backup_unverified" : outcome]);
  if (outcome === "changed" || outcome === "missing") expect(download).not.toHaveBeenCalled();
  else { expect(download).toHaveBeenCalledOnce(); expect(Buffer.from(download.mock.calls[0]![1], "base64")).toEqual(original); }
  if (outcome === "changed" || outcome === "missing") {
    expect((await f.read(card)).snapshot.data).toMatchObject({ download: { availability: "ended", endReason: "source_unavailable" } });
    return; // A corrupted or missing private snapshot is never revived by retry.
  }
  const oldReads = read.mock.calls.length, previousAttemptId = file.attemptId;
  file.attemptId = randomUUID();
  const retried = await f.act(finished, { action: "settings_retry_download", operationId: view.operationId,
    fileId: file.fileId, previousAttemptId, attemptId: file.attemptId });
  expect(retried.error).toBeUndefined(); finished = { ...retried, permission: card.permission };
  download.mockResolvedValue({ isError: false });
  await downloadSettingsFile(file, transport, (status) => statuses.push(status), () => true);
  expect(statuses.at(-1)).toBe("acknowledged"); expect(read.mock.calls.length).toBeGreaterThan(oldReads);
  expect(await readFile(path)).toEqual(original); expect(f.wallet.sign).not.toHaveBeenCalled();
});
