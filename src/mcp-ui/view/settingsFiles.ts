import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { settingsViewSchema, SETTINGS_IMPORT_MAX_SIZE } from "../../core/session/settingsOperation.js";
import type { SettingsViewTransport } from "./lifecycle.js";

export function settingsBase64(data: Uint8Array): string {
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary);
}
function settingsDecode(value: string): Uint8Array {
  const binary = atob(value), data = Uint8Array.from(binary, (item) => item.charCodeAt(0));
  if (settingsBase64(data) !== value) throw new Error("Part of the backup could not be read correctly.");
  return data;
}

export type SettingsUploadProgress = { stage: "reading" | "receiving" | "checking"; operationId: string; cardId: string;
  fileId?: string; sha256?: string };
export async function uploadSettingsFile(file: File, transport: SettingsViewTransport, current: () => { operationId: string; cardId: string },
  active: () => boolean, progress?: (value: SettingsUploadProgress) => void): Promise<void> {
  if (file.size > SETTINGS_IMPORT_MAX_SIZE) throw new Error("This backup exceeds the 16 MiB limit. Choose a smaller backup.");
  const target = current();
  transport.setFileTransferActive(true);
  try {
    if (active()) progress?.({ ...target, stage: "reading" });
    const data = new Uint8Array(await file.arrayBuffer()), sha = bytesToHex(sha256(data));
    if (!active()) return;
    progress?.({ ...target, stage: "receiving", sha256: sha });
    let snapshot = await transport.act({ action: "settings_begin_upload", operationId: target.operationId, name: file.name,
      totalSize: data.length, sha256: sha }, true);
    let view = settingsViewSchema.parse(snapshot.data), received = view.file?.receivedSize ?? 0;
    const uploadId = view.file?.fileId;
    if (!uploadId || view.operationId !== target.operationId || view.file?.sha256 !== sha || view.file.totalSize !== data.length) throw new Error("The file being received does not match your selection. Choose the backup file again.");
    if (active()) progress?.({ ...target, stage: "receiving", fileId: uploadId, sha256: sha });
    // The frame measures its actual credential/arguments. Extra Host wrapping
    // is corrected by the backend before any write at this same offset.
    let budget = transport.uploadChunkLimit(target.operationId, uploadId);
    while (active() && received < data.length) {
      if (budget < 1) throw new Error("This app cannot send the backup within its message size limit. Try opening Settings in another supported app.");
      const amount = Math.min(budget, data.length - received);
      const input = { action: "settings_upload_chunk", operationId: target.operationId, fileId: uploadId,
        offset: received, chunkBase64: settingsBase64(data.subarray(received, received + amount)) };
      try { snapshot = await transport.act(input, true); }
      catch (error) {
        const details = error && typeof error === "object" && "data" in error ? error.data as { code?: unknown; rawChunkLimit?: unknown } | undefined : undefined;
        if (details?.code !== "settings_payload_too_large" || typeof details.rawChunkLimit !== "number" || !Number.isSafeInteger(details.rawChunkLimit) ||
            details.rawChunkLimit < 1 || details.rawChunkLimit >= amount) throw error;
        const confirmed = settingsViewSchema.parse((await transport.readCurrent()).snapshot.data);
        if (confirmed.file?.fileId !== uploadId || confirmed.file.receivedSize !== received) throw new Error("The file transfer changed after a message was rejected. Choose the same file again to check how much was received.");
        budget = details.rawChunkLimit; continue;
      }
      view = settingsViewSchema.parse(snapshot.data);
      if (view.operationId !== target.operationId || view.file?.fileId !== uploadId || view.file.sha256 !== sha || view.file.receivedSize !== received + amount) throw new Error("The file transfer could not be confirmed. Choose the same file again to continue.");
      received = view.file.receivedSize;
    }
    if (active()) {
      progress?.({ ...target, stage: "checking", fileId: uploadId, sha256: sha });
      await transport.act({ action: "settings_seal_upload", operationId: target.operationId, fileId: uploadId }, true);
    }
  } finally { transport.setFileTransferActive(false); }
}

export type SettingsDownloadStatus = "pending" | "backup_unverified" | "acknowledged" | "not_completed" | "unconfirmed" | "unsupported";
export async function downloadSettingsFile(file: { operationId: string; fileId: string; displayName: string; totalSize: number; sha256: string; attemptId: string },
  transport: SettingsViewTransport, status: (value: SettingsDownloadStatus) => void, active: () => boolean): Promise<SettingsDownloadStatus | undefined> {
  status("pending");
  let data: Uint8Array;
  try {
    data = new Uint8Array(file.totalSize);
    let offset = 0;
    while (offset < data.length && active()) {
      const value = await transport.readFile({ operationId: file.operationId, fileId: file.fileId, offset, attemptId: file.attemptId });
      const chunk = settingsDecode(value.chunkBase64);
      if (value.totalSize !== data.length || value.sha256 !== file.sha256 || !chunk.length || offset + chunk.length > data.length) throw new Error("Part of the downloaded backup does not match the original file.");
      data.set(chunk, offset); offset += chunk.length;
    }
    if (!active()) return;
    if (offset !== data.length || bytesToHex(sha256(data)) !== file.sha256) throw new Error("The complete downloaded backup could not be checked against the original file.");
  } catch {
    if (active()) { try { await transport.readCurrent(); } catch { /* The lifecycle owns current-read recovery. */ } }
    if (active()) status("backup_unverified"); return "backup_unverified";
  }
  {
    try {
      const read = await transport.readCurrent();
      const current = settingsViewSchema.parse(read.snapshot.data);
      if (!active() || current.operationId !== file.operationId || current.file?.fileId !== file.fileId ||
          current.file.sha256 !== file.sha256 || current.file.totalSize !== file.totalSize ||
          current.download?.currentAttemptId !== file.attemptId || current.download.localSave || current.download.availability !== "available" ||
          !current.download.remainingMs) return;
      // The remaining period was computed before the reply arrived. Include
      // the original read's elapsed time even when this call joined its flight.
      // A delayed reply cannot grant a fresh period for already-received bytes.
      if (current.download.remainingMs <= Math.max(0, performance.now() - read.requestStartedAt)) {
        try { await transport.readCurrent(); } catch { /* Current-read recovery belongs to the lifecycle. */ }
        return;
      }
    } catch { if (active()) status("backup_unverified"); return "backup_unverified"; }
  }
  try {
    if (!active()) return;
    const response = await transport.download(file.displayName, settingsBase64(data), file.attemptId);
    const outcome = response.unsupported === true ? "unsupported" : response.isError === true ? "not_completed" : "acknowledged";
    if (active()) status(outcome);
    return outcome;
  } catch { if (active()) status("unconfirmed"); return "unconfirmed"; }
}
