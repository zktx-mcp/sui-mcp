import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { validateSupportedAdapterLifecycle } from "../adapters/adapterLifecycleValidators.js";
import { validateBackupBytes } from "../core/activity/localDataValidation.js";
import { LocalDataError, type LocalDataEnvelope } from "../core/activity/localDataTypes.js";
import { SETTINGS_IMPORT_MAX_SIZE } from "../core/session/settingsOperation.js";

type ValidationResult = { envelope: LocalDataEnvelope } | { message: string; details: Record<string, unknown> };

export async function validateSealedBackup(bytes: Buffer): Promise<LocalDataEnvelope> {
  if (bytes.length > SETTINGS_IMPORT_MAX_SIZE) throw new LocalDataError("input_invalid", "The backup exceeds the restore limit.", { reason: "invalid_backup_shape" });
  if (bytes.length <= 64 * 1024) return validateBackupBytes(bytes, validateSupportedAdapterLifecycle);
  // Transfer a private copy. A pooled file buffer may share its backing memory with other I/O.
  const input = Uint8Array.from(bytes);
  const source = import.meta.url;
  const entry = source.endsWith(".ts")
    ? new URL("data:text/javascript," + encodeURIComponent(`import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(source)}, ${JSON.stringify(source)});`))
    : new URL(source);
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, { workerData: input, transferList: [input.buffer], execArgv: [] });
    worker.once("message", (result: ValidationResult) => {
      if ("envelope" in result) resolve(result.envelope);
      else reject(new LocalDataError("input_invalid", result.message, result.details));
    });
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("Backup validation ended without a result.")));
  });
}

if (!isMainThread && parentPort && workerData instanceof Uint8Array) {
  let result: ValidationResult;
  try { result = { envelope: validateBackupBytes(workerData, validateSupportedAdapterLifecycle) }; }
  catch (error) {
    if (!(error instanceof LocalDataError) || error.kind !== "input_invalid") throw error;
    result = { message: error.message, details: error.details };
  }
  parentPort.postMessage(result);
}
