import type { CallToolResult } from "@modelcontextprotocol/server";
import { assertNoForbiddenMcpFields } from "../core/action/forbiddenFields.js";
import type { McpToolErrorPayload, McpToolPayload, ToolError, UnknownRecord } from "../core/action/types.js";

export function okToolResult<T extends UnknownRecord>(data: T): CallToolResult {
  const payload: McpToolPayload<T> = { ok: true, data };
  assertNoForbiddenMcpFields(payload);
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

export function errorToolResult(error: ToolError): CallToolResult {
  const payload: McpToolErrorPayload = { ok: false, error };
  assertNoForbiddenMcpFields(payload);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}
