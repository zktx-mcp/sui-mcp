import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsFileStore, decodeSettingsChunk } from "../src/core/session/settingsFileStore.js";
import type { SettingsFile } from "../src/core/session/settingsOperation.js";
import { MAX_JSON_BODY_BYTES, settingsRawChunkBudget, settingsUploadMessageBudget } from "../src/core/session/settingsFileProtocol.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// NIST CAVS 11.0, byte-oriented SHA256ShortMsg.rsp, Len=0 and Len=8.
// https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/shs/shabytetestvectors.zip
// The Len=0 Msg=00 field is a placeholder, not a one-byte input.
it.each([
  { bits: 0, msg: "00", md: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { bits: 8, msg: "d3", md: "28969cdfa74a12c82f3bad960b0b000aca2ac329deea5c2328ebc6f2ba9802c1" }
])("checks Node and browser Noble independently against NIST Len=$bits", ({ bits, msg, md }) => {
  const bytes = bits === 0 ? Buffer.alloc(0) : Buffer.from(msg, "hex");
  expect(bytes.length * 8).toBe(bits);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(md);
  expect(bytesToHex(sha256(bytes))).toBe(md);
});

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function fixture(data: Buffer, role: "upload" | "export" = "upload") {
  const directory = await mkdtemp(join(tmpdir(), "sui-mcp-settings-file-")); directories.push(directory);
  const fileId = randomUUID(), operationId = randomUUID();
  const file: SettingsFile = { fileId, operationId, role, relativePath: role === "upload" ? `.settings-staging/${fileId}.upload` : `backups/${operationId}.json`,
    displayName: "User supplied ../資料.json", totalSize: data.length, receivedSize: 0, sha256: digest(data), sealed: false, invalidated: false, cleanup: "pending" };
  return { directory, file, files: new SettingsFileStore(directory) };
}

it("completes only the matching reserved chunk after a partial physical write", async () => {
  const data = Buffer.from('{"message":"Unicode 資料"}'); const f = await fixture(data);
  await f.files.createUpload(f.file);
  const reserved = { ...f.file, reservation: { offset: 0, length: data.length, sha256: digest(data) } };
  await writeFile(join(f.directory, f.file.relativePath), data.subarray(0, 7));
  await f.files.writeReservedChunk(reserved, data);
  const complete = { ...f.file, receivedSize: data.length };
  expect(await f.files.readUpload(complete)).toEqual(data);
  await f.files.verifyUploadPrefix(complete, 0, data);
  await expect(f.files.verifyUploadPrefix(complete, 0, Buffer.alloc(data.length, 1))).rejects.toThrow("Different file content");
  expect((await stat(join(f.directory, f.file.relativePath))).size).toBe(data.length);
});

it("rejects a different physical prefix and never overwrites it", async () => {
  const data = Buffer.from("expected backup"); const f = await fixture(data);
  await f.files.createUpload(f.file);
  const wrong = Buffer.from("wrong"); await writeFile(join(f.directory, f.file.relativePath), wrong);
  await expect(f.files.writeReservedChunk({ ...f.file, reservation: { offset: 0, length: data.length, sha256: digest(data) } }, data)).rejects.toThrow("already received has changed");
  expect(await readFile(join(f.directory, f.file.relativePath))).toEqual(wrong);
});

it("creates one private snapshot and verifies that same artifact on range reads", async () => {
  const data = Buffer.from('{"public":"records"}'), f = await fixture(data, "export");
  f.file.relativePath = `.settings-staging/${f.file.fileId}.download`;
  const path = join(f.directory, f.file.relativePath);
  await f.files.createDownload(f.file, data);
  const sealed = { ...f.file, sealed: true, receivedSize: data.length };
  expect(await f.files.readDownloadRange(sealed, 1, 4)).toEqual(data.subarray(1, 5));
  await expect(f.files.createDownload(f.file, data)).rejects.toThrow();
  expect(await readFile(path)).toEqual(data);
  await writeFile(path, Buffer.alloc(data.length, 33));
  await expect(f.files.readDownloadRange(sealed, 1, 4)).rejects.toThrow("content changed");
  await f.files.cleanup({ ...sealed, invalidated: true });
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(f.directory, "backups")).catch(() => [])).toEqual([]);
});

it("reads an existing public backup and never removes it during temporary cleanup", async () => {
  const data = Buffer.from('{"saved":"user backup"}'), f = await fixture(data, "export");
  await mkdir(join(f.directory, "backups")); const path = join(f.directory, f.file.relativePath);
  await writeFile(path, data, { flag: "wx" });
  const sealed = { ...f.file, sealed: true, receivedSize: data.length };
  expect(await f.files.readExportRange(sealed, 1, 4)).toEqual(data.subarray(1, 5));
  await f.files.cleanup(sealed); expect(await readFile(path)).toEqual(data);
  await writeFile(path, Buffer.alloc(data.length, 33));
  await expect(f.files.readExportRange(sealed, 1, 4)).rejects.toThrow("content changed");
});

it("rejects a staging-directory symlink without following them", async () => {
  const data = Buffer.from("outside unchanged"); const f = await fixture(data);
  const outside = await mkdtemp(join(tmpdir(), "sui-mcp-file-outside-")); directories.push(outside);
  await mkdir(join(outside, "kept"));
  await symlink(join(outside, "kept"), join(f.directory, ".settings-staging"));
  await expect(f.files.createUpload(f.file)).rejects.toThrow("directory is unavailable");
  expect(await readdir(join(outside, "kept"))).toEqual([]);
});

it("does not overwrite a preexisting file at the reserved private snapshot path", async () => {
  const data = Buffer.from("new snapshot"), prior = Buffer.from("user's existing file"); const f = await fixture(data, "export");
  f.file.relativePath = `.settings-staging/${f.file.fileId}.download`;
  await mkdir(join(f.directory, ".settings-staging"));
  const path = join(f.directory, f.file.relativePath);
  await writeFile(path, prior);
  await expect(f.files.createDownload(f.file, data)).rejects.toThrow();
  expect(await readFile(path)).toEqual(prior);
});

it.each(["A", "a===", "YQ", "YQ=", "YR==", "YQ==\n"])("rejects noncanonical Base64 %s", (value) => {
  expect(() => decodeSettingsChunk(value)).toThrow("not encoded correctly");
});

it.each([0, 1, 2, 3, 4])("keeps the independent serialized size within 64 KiB for raw padding %i", (padding) => {
  const envelope = { jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, method: "tools/call", params: { name: "ui.act_card",
    arguments: { cardId: "card", permission: "scoped-ui-permission", revision: Number.MAX_SAFE_INTEGER,
      input: { action: "settings_upload_chunk", operationId: randomUUID(), fileId: randomUUID(), offset: 16 * 1024 * 1024, chunkBase64: "" } },
    _meta: { hostMessage: "Unicode 資料" } } };
  const room = MAX_JSON_BODY_BYTES - Buffer.byteLength(JSON.stringify(envelope));
  const independent = 3 * Math.floor(room / 4);
  expect(settingsRawChunkBudget(envelope)).toBe(independent);
  expect(settingsUploadMessageBudget(envelope)).toBe(independent);
  const count = independent - (independent % 3) - padding;
  envelope.params.arguments.input.chunkBase64 = Buffer.alloc(count).toString("base64");
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(65536);
  envelope.params.arguments.input.chunkBase64 = Buffer.alloc(independent + 1).toString("base64");
  expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(65536);
});
