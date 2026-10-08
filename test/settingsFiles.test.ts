import { readFile, writeFile, unlink } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { settingsWorkflowFixture } from "./fixtures/settingsWorkflow.js";
import { downloadSettingsFile, type SettingsDownloadStatus } from "../src/mcp-ui/view/settingsFiles.js";
import type { SettingsViewTransport } from "../src/mcp-ui/view/lifecycle.js";
import type { SettingsView } from "../src/core/session/settingsOperation.js";
const close: (() => void)[] = [];
afterEach(() => { for (const clean of close.splice(0).reverse()) clean(); });

it.each(["changed", "missing", "acknowledged", "not_completed", "unconfirmed"])("distinguishes backup verification from Host delivery (%s) and rereads the same file on retry", async (outcome) => {
  const f = await settingsWorkflowFixture(); close.push(f.close);
  const card = await f.prepare({ kind: "export_local_data" }); await f.confirm(card);
  let finished = await f.read(card);
  await vi.waitFor(async () => { finished = await f.read(card); expect((finished.snapshot.data as SettingsView).result?.outcome).toBe("completed"); });
  const view = finished.snapshot.data as SettingsView, details = view.result!.details!;
  const path = String(details.path), original = await readFile(path);
  const download = vi.fn(async (_name: string, _data: string) => {
    if (outcome === "unconfirmed") throw new Error("Host response unavailable");
    return { isError: outcome === "not_completed" };
  });
  if (outcome === "changed") await writeFile(path, Buffer.alloc(original.length, 1));
  if (outcome === "missing") await unlink(path);
  const statuses: SettingsDownloadStatus[] = [];
  const record = f.wallet.run(() => f.wallet.cardRecords.get(card.snapshot.cardId))!;
  const read = vi.fn(async (input: { fileId: string; offset: number }) => f.wallet.run(async () => {
    const range = await f.settings.readFile(record, input.fileId, input.offset, 32768);
    return { ...range.file, cardId: card.snapshot.cardId, offset: range.offset, chunkBase64: range.chunkBase64 };
  }));
  const transport: SettingsViewTransport = { canDownload: () => true, download, readFile: read,
    act: async () => { throw new Error("Download cannot apply Settings"); }, readCurrent: async () => finished.snapshot,
    uploadChunkLimit: () => 1, setFileTransferActive() {} };
  const file = { operationId: view.operationId, fileId: view.file!.fileId, displayName: view.file!.displayName,
    totalSize: view.file!.totalSize, sha256: view.file!.sha256 };
  await downloadSettingsFile(file, transport, (status) => statuses.push(status), () => true);
  expect(statuses).toEqual(["pending", outcome === "changed" || outcome === "missing" ? "backup_unverified" : outcome]);
  if (outcome === "changed" || outcome === "missing") expect(download).not.toHaveBeenCalled();
  else { expect(download).toHaveBeenCalledOnce(); expect(Buffer.from(download.mock.calls[0]![1], "base64")).toEqual(original); }
  const oldReads = read.mock.calls.length;
  await writeFile(path, original); download.mockResolvedValue({ isError: false });
  await downloadSettingsFile(file, transport, (status) => statuses.push(status), () => true);
  expect(statuses.at(-1)).toBe("acknowledged"); expect(read.mock.calls.length).toBeGreaterThan(oldReads);
  expect(await readFile(path)).toEqual(original); expect(f.wallet.sign).not.toHaveBeenCalled();
});
