// The existing internal card/HTTP limit applies to the complete JSON-RPC message.
import { SETTINGS_IMPORT_MAX_SIZE } from "./settingsOperation.js";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export function settingsJsonSize(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).length; }
export function settingsRawChunkBudget(envelopeWithEmptyBase64: unknown): number {
  const room = MAX_JSON_BODY_BYTES - settingsJsonSize(envelopeWithEmptyBase64);
  return room > 0 ? 3 * Math.floor(room / 4) : 0;
}

// The actual request may carry additional Host metadata. Rejection happens
// before dispatch; its independently measured room lets the same offset retry.
export function settingsUploadMessageBudget(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined;
  const envelope = structuredClone(message) as { id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: {
    revision?: unknown; input?: { action?: unknown; offset?: unknown; chunkBase64?: unknown }
  } } };
  if (envelope.method !== "tools/call" || envelope.params?.name !== "ui.act_card" ||
      envelope.params.arguments?.input?.action !== "settings_upload_chunk") return undefined;
  // Safe-integer decimal maxima cover ids/revisions; upload offsets use the
  // accepted raw-file limit.
  envelope.id = Number.MAX_SAFE_INTEGER;
  envelope.params.arguments.revision = Number.MAX_SAFE_INTEGER;
  envelope.params.arguments.input.offset = SETTINGS_IMPORT_MAX_SIZE;
  envelope.params.arguments.input.chunkBase64 = "";
  return settingsRawChunkBudget(envelope);
}
