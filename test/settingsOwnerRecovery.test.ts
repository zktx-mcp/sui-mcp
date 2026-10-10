import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { acquireDataDirectoryOwner } from "../src/runtime/shared/ownerLease.js";
import type { CardResponse } from "../src/core/session/cardSession.js";
import type { SettingsDraft, SettingsView } from "../src/core/session/settingsOperation.js";

type Event = { event: string; name?: string; message?: string; card: CardResponse & { permission: string }; creations: number; publications: number;
  control: { data_epoch: number; active_operation_id: string | null; file_io_id: string | null; wallet_input_blocked: number }; account: { address: string } | null };
const children: ChildProcess[] = [], directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function actor(directory: string, fault = "none") {
  const child = fork(new URL("./fixtures/settingsOwnerProcess.ts", import.meta.url), [directory, fault], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const events: Event[] = []; let diagnostic = "";
  child.stderr!.on("data", (data: Buffer) => { diagnostic += data.toString(); });
  child.on("message", (event: Event) => events.push(event));
  const next = async (name: string): Promise<Event> => {
    const end = Date.now() + 15000; // Existing real SDK/process fixture observation budget, never a product deadline.
    while (Date.now() < end) {
      const index = events.findIndex((value) => value.event === name || value.event === "error");
      if (index >= 0) { const event = events.splice(index, 1)[0]!; if (event.event === "error") throw new Error(event.message); return event; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture parent exited: ${diagnostic}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Fixture observation ${name} did not arrive: ${diagnostic}`);
  };
  await next("ready");
  return { child, next, send: (value: unknown) => child.send(value as object),
    async kill() { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } };
}
const view = (event: Event) => event.card.snapshot.data as SettingsView;
async function directory() { const value = await mkdtemp(join(tmpdir(), "sui-settings-owner-")); directories.push(value); return value; }

it("keeps the committed snapshot result and settles ended cleanup after actual parent exit", async () => {
  const dir = await directory(), first = await actor(dir, "result_after");
  first.send({ command: "prepare", draft: { kind: "download_backup" } }); const prepared = await first.next("prepared");
  first.send({ command: "confirm" }); await first.next("boundary");
  const db = new Database(join(dir, "activity.sqlite"));
  try {
    const operationId = view(prepared).operationId;
    const operation = db.prepare("SELECT phase,result_json FROM settings_operations WHERE operation_id=?").get(operationId) as { phase: string; result_json: string };
    const file = db.prepare("SELECT file_id,relative_path,cleanup FROM settings_files WHERE operation_id=?").get(operationId) as { file_id: string; relative_path: string; cleanup: string };
    expect(operation.phase).toBe("terminal"); const originalResult = JSON.parse(operation.result_json);
    expect(originalResult).toMatchObject({ outcome: "completed", completionScope: "backup_snapshot" }); expect(file.cleanup).toBe("complete");
    expect(db.prepare("SELECT file_io_id FROM settings_control WHERE id=1").get()).toEqual({ file_io_id: file.file_id });
    await expect(readFile(join(dir, file.relative_path))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => acquireDataDirectoryOwner(join(dir, "activity.sqlite"))).toThrow("runtime owner");
    await first.kill(); db.exec("DROP TRIGGER refuse_finished_release");
    const second = await actor(dir); second.send({ command: "read", reference: { cardId: prepared.card.snapshot.cardId, permission: prepared.card.permission } });
    const restored = await second.next("read"); expect(view(restored).result).toEqual(originalResult);
    expect(restored.control).toMatchObject({ file_io_id: null, active_operation_id: null }); expect(restored.creations).toBe(0);
    expect(view(restored).download?.allowedFileActions).toEqual([]);
    second.send({ command: "read" }); expect(view(await second.next("read")).result).toEqual(originalResult);
    await second.kill();
  } finally { db.close(); }
}, 25000);

it.each(["write_before", "write_partial", "write_after", "sync_before", "sync_after", "result_before"])(
  "ends a private download after actual parent exit at %s without regenerating it", async (fault) => {
    const dir = await directory(), first = await actor(dir, fault);
    first.send({ command: "prepare", draft: { kind: "download_backup" } }); const prepared = await first.next("prepared");
    first.send({ command: "confirm" }); await first.next("boundary");
    const db = new Database(join(dir, "activity.sqlite")), operationId = view(prepared).operationId;
    const file = db.prepare("SELECT * FROM settings_files WHERE operation_id=?").get(operationId) as { file_id: string; sha256: string; total_size: number; relative_path: string };
    const path = join(dir, file.relative_path), bytes = await readFile(path);
    expect(file.relative_path).toBe(`.settings-staging/${file.file_id}.download`);
    if (fault === "write_before") expect(bytes.length).toBe(0);
    else if (fault === "write_partial") expect(bytes.length).toBe(7);
    else { expect(bytes.length).toBe(file.total_size); expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256); }
    expect(await readdir(join(dir, "backups")).catch(() => [])).toEqual([]);
    expect(() => acquireDataDirectoryOwner(join(dir, "activity.sqlite"))).toThrow("runtime owner");
    await first.kill(); db.exec("DROP TRIGGER IF EXISTS refuse_result"); db.close();
    const second = await actor(dir); second.send({ command: "read", reference: { cardId: prepared.card.snapshot.cardId, permission: prepared.card.permission } });
    const recovered = await second.next("read");
    expect(view(recovered).result?.outcome).toBe("interrupted");
    expect(view(recovered).download).toMatchObject({ availability: "ended", endReason: "server_restarted", allowedFileActions: [] });
    expect(recovered.creations).toBe(0); expect(recovered.control).toMatchObject({ active_operation_id: null, file_io_id: null });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readdir(join(dir, ".settings-staging"))).toEqual([]);
    second.send({ command: "read" }); expect(view(await second.next("read")).result).toEqual(view(recovered).result);
    await second.kill();
  }, 25000);

it.each([false, true])("reads a historical published artifact after owner exit and never deletes the user's file (changed=%s)", async (changed) => {
  const dir = await directory(), first = await actor(dir);
  first.send({ command: "historical_export" }); const prepared = await first.next("historical_export"); await first.kill();
  const path = join(dir, "backups", `${view(prepared).operationId}.json`);
  if (changed) await writeFile(path, Buffer.from("user replacement"));
  const bytes = await readFile(path), second = await actor(dir);
  second.send({ command: "read", reference: { cardId: prepared.card.snapshot.cardId, permission: prepared.card.permission } });
  const result = await second.next("read"); expect(view(result).result?.outcome).toBe(changed ? "interrupted" : "completed");
  expect(await readFile(path)).toEqual(bytes); expect(result.creations).toBe(0); await second.kill();
}, 25000);

it("reports unavailable exclusive snapshot creation and allows another Settings action", async () => {
  const dir = await directory(), first = await actor(dir, "unsupported_create");
  first.send({ command: "prepare", draft: { kind: "download_backup" } }); await first.next("prepared");
  first.send({ command: "confirm" }); await first.next("admitted");
  let result: Event;
  do { first.send({ command: "read" }); result = await first.next("read"); } while (!view(result).result);
  expect(view(result).result?.outcome).toBe("failed"); expect(result.creations).toBe(0);
  expect(await readdir(join(dir, ".settings-staging"))).toEqual([]);
  first.send({ command: "prepare", draft: { kind: "clear_read_address" } }); await first.next("prepared");
  first.send({ command: "confirm" }); expect(view(await first.next("admitted")).result?.outcome).toBe("completed"); await first.kill();
}, 25000);

it.each(["reset_local_data", "import_local_data"] as const)("preserves %s commit and its exact read-only result after parent exit without repeating replacement", async (kind) => {
  const dir = await directory(), first = await actor(dir);
  first.send({ command: "prepare", draft: { kind } satisfies SettingsDraft }); const prepared = await first.next("prepared");
  first.send({ command: "confirm" }); const committed = await first.next("admitted"); expect(view(committed).result?.outcome).toBe("completed");
  await first.kill(); const second = await actor(dir);
  second.send({ command: "read", reference: { cardId: prepared.card.snapshot.cardId, permission: prepared.card.permission } });
  const restored = await second.next("read"); expect(view(restored).result).toEqual(view(committed).result); expect(restored.control.data_epoch).toBe(1);
  expect(restored.card.snapshot.state).toBe("closed"); expect(view(restored).allowedActions).toEqual([]);
  second.send({ command: "read" }); expect((await second.next("read")).control.data_epoch).toBe(1); await second.kill();
}, 25000);

it.each(["reset_local_data", "import_local_data"] as const)("does not apply %s when the prepared parent exits before commit", async (kind) => {
  const dir = await directory(), first = await actor(dir, kind === "import_local_data" ? "verify_before" : "none");
  first.send({ command: "prepare", draft: { kind } }); const prepared = await first.next("prepared");
  if (kind === "import_local_data") { first.send({ command: "confirm" }); await first.next("boundary"); }
  await first.kill(); const second = await actor(dir);
  second.send({ command: "read", reference: { cardId: prepared.card.snapshot.cardId, permission: prepared.card.permission } });
  const restored = await second.next("read"); expect(view(restored).result?.outcome).toBe("interrupted");
  expect(restored.control.data_epoch).toBe(0); expect(restored.account?.address).toBe(`0x${"a".repeat(64)}`); await second.kill();
}, 25000);

it.each(["stopping", "starting"])("ends an admitted Settings restart as interrupted after actual parent exit during %s", async (phase) => {
  const dir = await directory(), first = await actor(dir, phase);
  first.send({ command: "prepare", draft: { kind: "restart_wallet_service" } }); const prepared = await first.next("prepared");
  first.send({ command: "confirm" }); await first.next("admitted");
  let current: Event;
  do { first.send({ command: "read" }); current = await first.next("read"); } while (view(current).phase !== phase);
  expect(current.control.wallet_input_blocked).toBe(1); await first.kill();
  const second = await actor(dir); second.send({ command: "read", reference: { cardId: prepared.card.snapshot.cardId, permission: prepared.card.permission } });
  const restored = await second.next("read"); expect(view(restored).result?.outcome).toBe("interrupted");
  expect(restored.card.snapshot.reason).toBe("server_restarted"); expect(restored.control).toMatchObject({ active_operation_id: null, wallet_input_blocked: 0 });
  expect(view(restored).result?.message).not.toContain("before this operation was confirmed");
  await second.kill();
}, 25000);

it.each(["source_identity_before", "link_before", "link_after", "saved_before", "cleanup_before", "cleanup_after"])(
  "settles an actually interrupted local save at %s without restoring input or publishing again", async (fault) => {
    const dir = await directory(), first = await actor(dir, fault);
    first.send({ command: "prepare", draft: { kind: "download_backup" } }); const created = await first.next("prepared");
    const id = view(created).operationId;
    first.send({ command: "confirm" }); await first.next("admitted"); first.send({ command: "unsupported" });
    const cut = await first.next("boundary"); expect(cut.name).toBe(fault);
    const db = new Database(join(dir, "activity.sqlite"));
    let originalResult: unknown, fileId: string;
    try {
      const row = db.prepare("SELECT file_id,result_json,preparation_json FROM settings_operations WHERE operation_id=?").get(id) as { file_id: string; result_json: string; preparation_json: string };
      fileId = row.file_id; originalResult = JSON.parse(row.result_json);
      const save = JSON.parse(row.preparation_json).download.localSave;
      expect(save.status).toBe(fault.startsWith("cleanup_") ? "saved" : "saving");
      if (fault === "source_identity_before") expect(save.sourceIdentity).toBeUndefined(); else expect(save.sourceIdentity).toMatchObject({ device: expect.any(String), inode: expect.any(String) });
      expect(() => acquireDataDirectoryOwner(join(dir, "activity.sqlite"))).toThrow("runtime owner");
    } finally { db.close(); }
    await first.kill();
    const target = join(dir, "backups", `${id}.json`), shouldExist = !["source_identity_before", "link_before"].includes(fault);
    const bytes = shouldExist ? await readFile(target) : undefined;
    const second = await actor(dir);
    second.send({ command: "read", reference: { cardId: created.card.snapshot.cardId, permission: created.card.permission } });
    const recovered = await second.next("read"), current = view(recovered);
    expect(current.result).toEqual(originalResult); expect(current.allowedActions).toEqual([]); expect(current.download?.allowedFileActions).toEqual([]);
    expect(recovered.creations).toBe(0); expect(recovered.publications).toBe(0);
    expect(recovered.control).toMatchObject({ active_operation_id: null, file_io_id: null });
    expect(current.temporaryFileCleanup).toBe("complete");
    await expect(readFile(join(dir, ".settings-staging", `${fileId!}.download`))).rejects.toMatchObject({ code: "ENOENT" });
    if (shouldExist) {
      expect(current.download).toMatchObject({ endReason: "stored_locally", localSave: { status: "saved" } });
      expect(current.backupLocation).toEqual({ directory: join(dir, "backups"), filename: `${id}.json` });
      expect(await readFile(target)).toEqual(bytes);
    } else {
      expect(current.download).toMatchObject({ endReason: "server_restarted", localSave: { status: "failed", failure: "interrupted" } });
      expect(current.backupLocation).toBeUndefined(); await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await second.kill();
  }, 25000);

it.each(["different_inode", "missing_source", "changed_bytes"])("refuses to adopt an interrupted publication with %s evidence", async (change) => {
  const dir = await directory(), first = await actor(dir, "link_after");
  first.send({ command: "prepare", draft: { kind: "download_backup" } }); const created = await first.next("prepared"), id = view(created).operationId;
  first.send({ command: "confirm" }); await first.next("admitted"); first.send({ command: "unsupported" });
  await first.next("boundary"); await first.kill();
  const db = new Database(join(dir, "activity.sqlite"));
  const record = db.prepare("SELECT file_id FROM settings_operations WHERE operation_id=?").get(id) as { file_id: string }; db.close();
  const target = join(dir, "backups", `${id}.json`), original = await readFile(target);
  if (change === "different_inode") { await unlink(target); await writeFile(target, original, { flag: "wx" }); }
  else if (change === "missing_source") await unlink(join(dir, ".settings-staging", `${record.file_id}.download`));
  else await writeFile(target, Buffer.alloc(original.length, 1));
  const expected = await readFile(target), second = await actor(dir);
  second.send({ command: "read", reference: { cardId: created.card.snapshot.cardId, permission: created.card.permission } });
  const recovered = await second.next("read");
  expect(view(recovered).download?.localSave).toMatchObject({ status: "failed", failure: change === "different_inode" ? "target_conflict" : "source_unavailable" });
  expect(view(recovered).backupLocation).toBeUndefined(); expect(view(recovered).download?.allowedFileActions).toEqual([]);
  expect(recovered.creations).toBe(0); expect(recovered.publications).toBe(0); expect(await readFile(target)).toEqual(expected);
  await second.kill();
}, 25000);
