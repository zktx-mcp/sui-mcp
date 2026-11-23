import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  DiagnosticsInputError,
  TEMP_ARTIFACT_DIR_PREFIX
} from "./sui-cli-transaction-diagnostics-types.js";

export function timestampForPath(now: Date): string {
  return now.toISOString().replace(/:/g, "-").replace(".", "-");
}

export function pathFromUserInput(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function validateArtifactPath(path: string, cwd: string, label: string): string {
  const resolved = resolve(path);
  const workRoot = resolve(cwd, ".WORK", "sui-cli-diagnostics");
  const tempBase = diagnosticsTempDirBase(resolved);
  if (pathInside(resolved, workRoot)) {
    if (hasExistingSymlinkComponent(resolve(cwd, ".WORK"), resolved)) {
      throw new DiagnosticsInputError(`${label} must not contain symlink components.`);
    }
    assertNoExistingNonDirectoryComponent(resolve(cwd, ".WORK"), resolved, label);
    return resolved;
  }
  if (tempBase !== undefined) {
    if (hasExistingSymlinkComponent(tempBase, resolved)) {
      throw new DiagnosticsInputError(`${label} must not contain symlink components.`);
    }
    assertNoExistingNonDirectoryComponent(tempBase, resolved, label);
    return resolved;
  }
  throw new DiagnosticsInputError(`${label} must be under .WORK/sui-cli-diagnostics or a dedicated OS temp diagnostics directory.`);
}

export function validateTraceFilePath(path: string): string {
  const resolved = resolve(path);
  try {
    const stat = lstatSync(resolved);
    if (!stat.isFile()) {
      throw new DiagnosticsInputError("--trace-file must point to an existing regular file.");
    }
  } catch (error) {
    if (error instanceof DiagnosticsInputError) {
      throw error;
    }
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DiagnosticsInputError("--trace-file does not exist.");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new DiagnosticsInputError("--trace-file cannot be inspected because permission was denied.");
    }
    throw new DiagnosticsInputError("--trace-file could not be inspected.");
  }
  if (!/\.json\.zst$/i.test(resolved)) {
    throw new DiagnosticsInputError("--trace-file must use the .json.zst trace artifact extension.");
  }
  return resolved;
}

export function pathInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}



function diagnosticsTempDirBase(path: string): string | undefined {
  const tempRoot = resolve(tmpdir());
  const rel = relative(tempRoot, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  const firstSegment = rel.split(/[\\/]/, 1)[0];
  return firstSegment !== undefined && firstSegment.startsWith(TEMP_ARTIFACT_DIR_PREFIX)
    ? resolve(tempRoot, firstSegment)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function hasExistingSymlinkComponent(start: string, path: string): boolean {
  const resolvedStart = resolve(start);
  const resolvedPath = resolve(path);
  if (!pathInside(resolvedPath, resolvedStart)) {
    return false;
  }
  const parts = [resolvedStart, ...relative(resolvedStart, resolvedPath).split(/[\\/]/).filter((entry) => entry.length > 0)];
  let current = parts[0] as string;
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      current = resolve(current, parts[index] as string);
    }
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return true;
      }
    } catch {
      // Missing components cannot already be symlinks, so the existing prefix checked so far is the relevant boundary.
      return false;
    }
  }
  return false;
}

function assertNoExistingNonDirectoryComponent(start: string, path: string, label: string): void {
  const resolvedStart = resolve(start);
  const resolvedPath = resolve(path);
  if (!pathInside(resolvedPath, resolvedStart)) {
    return;
  }
  const parts = [resolvedStart, ...relative(resolvedStart, resolvedPath).split(/[\\/]/).filter((entry) => entry.length > 0)];
  let current = parts[0] as string;
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) {
      current = resolve(current, parts[index] as string);
    }
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory()) {
        throw new DiagnosticsInputError(`${label} must not contain existing non-directory components.`);
      }
    } catch (error) {
      if (error instanceof DiagnosticsInputError) {
        throw error;
      }
      return;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
