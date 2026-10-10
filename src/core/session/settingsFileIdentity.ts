import type { SettingsFile } from "./settingsOperation.js";

// Both the filesystem and replacement/cleanup journal use this exact private
// namespace. A display name or an export role alone is never a download path.
export function settingsDownloadPath(fileId: string): string {
  return `.settings-staging/${fileId}.download`;
}
export function settingsBackupPath(operationId: string): string { return `backups/${operationId}.json`; }
export function isSettingsDownloadFile(file: Pick<SettingsFile, "role" | "fileId" | "relativePath">): boolean {
  return file.role === "export" && file.relativePath === settingsDownloadPath(file.fileId);
}
export const SETTINGS_DOWNLOAD_FILE_SQL = "(role='export' AND relative_path=('.settings-staging/' || file_id || '.download'))";
export const SETTINGS_FILE_CLEANUP_SQL = `(invalidated=1 OR (role='export' AND NOT ${SETTINGS_DOWNLOAD_FILE_SQL}))`;
