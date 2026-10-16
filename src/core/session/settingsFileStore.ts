import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, link, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isSettingsDownloadFile, settingsBackupPath } from "./settingsFileIdentity.js";
import { SettingsConflict, type SettingsFile, type SettingsPhysicalFileIdentity, type SettingsLocalSaveOutcome } from "./settingsOperation.js";

export class SettingsDownloadPathExists extends SettingsConflict {}
function fileCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

export function settingsFileDigest(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
export function decodeSettingsChunk(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SettingsConflict("Part of the file was not encoded correctly.");
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) throw new SettingsConflict("Part of the file was not encoded correctly.");
  return data;
}

/** Private files are named from backend-generated identities only. SQLite owns
 * reservations and progress; this class verifies the corresponding physical fact. */
export class SettingsFileStore {
  constructor(private readonly dataDirectory: string) {}
  private directory(role: "staging" | "backups"): string {
    return join(this.dataDirectory, role === "staging" ? ".settings-staging" : "backups");
  }
  private assertId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new SettingsConflict("The selected file could not be identified.");
    }
  }
  private async prepareDirectory(role: "staging" | "backups"): Promise<string> {
    const directory = this.directory(role);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SettingsConflict("The local file directory is unavailable.");
    return directory;
  }
  private stagingPath(file: SettingsFile): string {
    this.assertId(file.fileId);
    if (file.role === "export" && !isSettingsDownloadFile(file)) {
      throw new SettingsConflict("The private backup path does not match this request.");
    }
    return join(this.directory("staging"), `${file.fileId}.${file.role === "upload" ? "upload" : "download"}`);
  }
  localBackupPath(file: SettingsFile): string {
    this.assertId(file.operationId);
    if (!isSettingsDownloadFile(file)) throw new SettingsConflict("This request does not own a download snapshot.");
    return join(this.dataDirectory, settingsBackupPath(file.operationId));
  }
  private async verifiedIdentity(handle: FileHandle, path: string, file: SettingsFile): Promise<SettingsPhysicalFileIdentity> {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(file.totalSize)) throw new SettingsConflict("The backup file size changed.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
    const after = await handle.stat({ bigint: true }), atPath = await lstat(path, { bigint: true });
    if (!atPath.isFile() || atPath.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
        after.dev !== atPath.dev || after.ino !== atPath.ino || after.size !== before.size || atPath.size !== before.size ||
        hash.digest("hex") !== file.sha256) throw new SettingsConflict("The backup file changed while it was checked.");
    return { device: before.dev.toString(), inode: before.ino.toString() };
  }
  private sameFile(left: SettingsPhysicalFileIdentity, right: SettingsPhysicalFileIdentity): boolean {
    return left.device === right.device && left.inode === right.inode;
  }
  private async downloadSourceIdentity(file: SettingsFile): Promise<SettingsPhysicalFileIdentity> {
    const directory = await lstat(this.directory("staging"));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new SettingsConflict("The backup staging directory changed.");
    const path = this.stagingPath(file), handle = await this.handle(path, constants.O_RDONLY);
    try { return await this.verifiedIdentity(handle, path, file); }
    finally { await handle.close(); }
  }
  async publishDownload(file: SettingsFile, rememberSource: (identity: SettingsPhysicalFileIdentity) => void): Promise<SettingsLocalSaveOutcome> {
    if (!isSettingsDownloadFile(file) || !file.sealed || file.invalidated) throw new SettingsConflict("The snapshot is not ready to save.");
    await this.prepareDirectory("backups");
    const source = this.stagingPath(file), destination = this.localBackupPath(file);
    // Persist the verified source identity before the only effect. Recovery
    // verifies this same inode; it never creates a missing destination.
    const identity = await this.downloadSourceIdentity(file);
    rememberSource(identity);
    try { await link(source, destination); }
    catch (error) {
      if (fileCode(error, "EEXIST")) return { status: "failed", reason: "target_conflict" };
      throw error;
    }
    return this.inspectDownloadPublication(file, identity);
  }
  async inspectDownloadPublication(file: SettingsFile, sourceIdentity: SettingsPhysicalFileIdentity | undefined): Promise<SettingsLocalSaveOutcome> {
    if (!isSettingsDownloadFile(file)) throw new SettingsConflict("The selected file is not a download snapshot.");
    const path = this.localBackupPath(file);
    let target: FileHandle;
    try {
      const directory = await lstat(this.directory("backups"));
      if (!directory.isDirectory() || directory.isSymbolicLink()) return { status: "failed", reason: "target_conflict" };
      target = await this.handle(path, constants.O_RDONLY);
    } catch (error) {
      if (fileCode(error, "ENOENT")) {
        try { await this.downloadSourceIdentity(file); return { status: "failed", reason: "not_published" }; }
        catch (sourceError) {
          if (sourceError instanceof SettingsConflict || fileCode(sourceError, "ENOENT") || fileCode(sourceError, "ELOOP")) return { status: "failed", reason: "source_unavailable" };
          throw sourceError;
        }
      }
      if (error instanceof SettingsConflict || fileCode(error, "ELOOP")) return { status: "failed", reason: "target_conflict" };
      throw error; // Unreadable is not absent; keep the admitted save unsettled.
    }
    try {
      if (!sourceIdentity) return { status: "failed", reason: "target_conflict" };
      const actualTarget = await this.verifiedIdentity(target, path, file);
      if (!this.sameFile(sourceIdentity, actualTarget)) return { status: "failed", reason: "target_conflict" };
      const actualSource = await this.downloadSourceIdentity(file);
      return this.sameFile(sourceIdentity, actualSource) ? { status: "saved" } : { status: "failed", reason: "source_unavailable" };
    } catch (error) {
      if (error instanceof SettingsConflict || fileCode(error, "ENOENT") || fileCode(error, "ELOOP")) return { status: "failed", reason: "source_unavailable" };
      throw error;
    } finally { await target.close(); }
  }
  private async handle(path: string, flags: number) {
    const file = await open(path, flags | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new SettingsConflict("The selected item is not a file that Sui MCP can read.");
      return file;
    } catch (error) { await file.close(); throw error; }
  }
  async createUpload(file: SettingsFile): Promise<void> {
    if (file.role !== "upload" || file.invalidated || file.receivedSize !== 0 ||
        file.relativePath !== `.settings-staging/${file.fileId}.upload`) throw new SettingsConflict("This file transfer is no longer available. Choose the backup file again.");
    await this.prepareDirectory("staging");
    const handle = await this.handle(this.stagingPath(file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async writeReservedChunk(file: SettingsFile, data: Buffer): Promise<void> {
    const reservation = file.reservation;
    if (file.role !== "upload" || file.invalidated || file.sealed || !reservation || reservation.offset !== file.receivedSize ||
        reservation.length !== data.length || reservation.sha256 !== settingsFileDigest(data) ||
        reservation.offset + data.length > file.totalSize) throw new SettingsConflict("The next part of the file does not match the expected content.");
    await this.prepareDirectory("staging");
    const handle = await this.handle(this.stagingPath(file), constants.O_RDWR);
    try {
      const length = (await handle.stat()).size;
      if (length < reservation.offset || length > reservation.offset + data.length) throw new SettingsConflict("The file size changed during transfer.");
      // A crash may leave the beginning of this exact reserved chunk. Verify it
      // before completing the remainder; never overwrite a different prefix.
      const written = length - reservation.offset;
      const prefix = Buffer.alloc(written);
      const read = await handle.read(prefix, 0, written, reservation.offset);
      if (read.bytesRead !== written || !prefix.equals(data.subarray(0, written))) throw new SettingsConflict("The part of the file already received has changed.");
      let offset = written;
      while (offset < data.length) {
        const result = await handle.write(data, offset, data.length - offset, reservation.offset + offset);
        if (!result.bytesWritten) throw new Error("Sui MCP could not save the next part of the file.");
        offset += result.bytesWritten;
      }
      await handle.sync();
      const actual = Buffer.alloc(data.length);
      const verified = await handle.read(actual, 0, data.length, reservation.offset);
      if (verified.bytesRead !== data.length || !actual.equals(data)) throw new SettingsConflict("The received part of the file could not be checked.");
    } finally { await handle.close(); }
  }
  async readUpload(file: SettingsFile): Promise<Buffer> {
    if (file.role !== "upload" || file.invalidated || file.receivedSize !== file.totalSize || file.reservation) {
      throw new SettingsConflict("The complete file has not been received yet.");
    }
    await this.prepareDirectory("staging");
    const handle = await this.handle(this.stagingPath(file), constants.O_RDONLY);
    try {
      if ((await handle.stat()).size !== file.totalSize) throw new SettingsConflict("The received file size has changed.");
      const data = Buffer.alloc(file.totalSize);
      const actual = await handle.read(data, 0, data.length, 0);
      if (actual.bytesRead !== data.length || settingsFileDigest(data) !== file.sha256) throw new SettingsConflict("The received file has changed or is incomplete.");
      return data;
    } finally { await handle.close(); }
  }
  async verifyUploadPrefix(file: SettingsFile, offset: number, data: Buffer): Promise<void> {
    if (file.role !== "upload" || file.invalidated || offset < 0 || offset + data.length > file.receivedSize) {
      throw new SettingsConflict("This part of the file has not been received.");
    }
    await this.prepareDirectory("staging");
    const handle = await this.handle(this.stagingPath(file), constants.O_RDONLY);
    try {
      const actual = Buffer.alloc(data.length), read = await handle.read(actual, 0, data.length, offset);
      if (read.bytesRead !== data.length || !actual.equals(data)) throw new SettingsConflict("Different file content was already received at this position.");
    } finally { await handle.close(); }
  }
  async createDownload(file: SettingsFile, data: Buffer): Promise<void> {
    if (!isSettingsDownloadFile(file) || file.invalidated || data.length !== file.totalSize || settingsFileDigest(data) !== file.sha256) {
      throw new SettingsConflict("The download snapshot does not match the selected records.");
    }
    await this.prepareDirectory("staging");
    let handle;
    try { handle = await this.handle(this.stagingPath(file), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new SettingsDownloadPathExists("The reserved backup location already contains a file.");
      }
      throw error;
    }
    try {
      await handle.writeFile(data); await handle.sync();
      if ((await handle.stat()).size !== file.totalSize) throw new SettingsConflict("The download snapshot length changed.");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== file.sha256) throw new SettingsConflict("The download snapshot content changed.");
    } finally { await handle.close(); }
  }
  async readDownloadRange(file: SettingsFile, offset: number, length: number): Promise<Buffer> {
    if (!isSettingsDownloadFile(file)) throw new SettingsConflict("This file is not the private download snapshot.");
    return this.readVerifiedRange(file, this.directory("staging"), this.stagingPath(file), offset, length);
  }
  private async readVerifiedRange(file: SettingsFile, directory: string, path: string, offset: number, length: number): Promise<Buffer> {
    if (!file.sealed || file.invalidated || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 1 || offset + length > file.totalSize) throw new SettingsConflict("This part of the backup is unavailable.");
    // Verify the artifact on the same open descriptor used for this chunk, so
    // path replacement cannot substitute unchecked content between two opens.
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SettingsConflict("The local backup directory changed.");
    const handle = await this.handle(path, constants.O_RDONLY);
    try {
      if ((await handle.stat()).size !== file.totalSize) throw new SettingsConflict("The local backup length changed.");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== file.sha256) throw new SettingsConflict("The local backup content changed.");
      const data = Buffer.alloc(length), actual = await handle.read(data, 0, length, offset);
      if (actual.bytesRead !== length) throw new SettingsConflict("The local backup read was incomplete.");
      return data;
    } finally { await handle.close(); }
  }
  async cleanup(file: SettingsFile): Promise<void> {
    await this.prepareDirectory("staging");
    try { await unlink(this.stagingPath(file)); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
    // The public backup is the user's artifact and is never removed here.
  }
}
