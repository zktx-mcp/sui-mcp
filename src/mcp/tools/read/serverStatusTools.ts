import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { noParamsInputSchema, successOutputSchema } from "../../schemas.js";
import { okToolResult } from "../../result.js";
import { MCP_PROMPTS } from "../../prompts.js";
import { MCP_RESOURCES } from "../../resources.js";
import {
  EVIDENCE_POLICY,
  FAIL_CLOSED_TOOLS,
  IMPLEMENTED_TOOLS,
  PACKAGE_NAME,
  SERVER_LIMITATIONS,
  SERVER_NAME,
  SERVER_NETWORK,
  SERVER_RUNTIME,
  SERVER_TRANSPORT,
  SERVER_VERSION
} from "../../serverInfo.js";
import { TOOL_NAMES } from "../../toolNames.js";

// Executable swap adapters precede protocol-notes-only entries.
export const SUPPORTED_PROTOCOLS = [
  { id: "deepbook-v3", status: "mainnet", support: "read_and_local_review" },
  { id: "deepbook-margin", status: "mainnet", support: "protocol_notes_only" }
] as const;

export function registerServerStatusTools(server: McpServer): void {
  server.registerTool(
    TOOL_NAMES.readGetServerStatus,
    {
      title: "Get server status",
      description: "Return package, runtime, tool, resource, and prompt status.",
      inputSchema: noParamsInputSchema,
      outputSchema: successOutputSchema({
        packageName: z.string(),
        serverName: z.string(),
        version: z.string(),
        evidencePolicy: z.object({
          version: z.string(),
          releaseGate: z.literal("intent_evidence_v1"),
          requiredFirstCheck: z.literal(true),
          requiredStatusFields: z.array(z.string()),
          gates: z.array(z.string())
        }),
        network: z.literal("mainnet"),
        runtime: z.literal("local_stdio"),
        transport: z.literal("grpc_graphql"),
        implementedTools: z.array(z.string()),
        implementedToolsCount: z.number().int().nonnegative(),
        failClosedTools: z.array(z.string()),
        resources: z.object({
          count: z.number().int().nonnegative(),
          uris: z.array(z.string()),
          items: z.array(
            z.object({
              name: z.string(),
              uri: z.string(),
              title: z.string(),
              description: z.string()
            })
          )
        }),
        prompts: z.object({
          count: z.number().int().nonnegative(),
          names: z.array(z.string())
        }),
        protocolsTool: z.literal("read.list_supported_protocols"),
        limitations: z.array(z.string())
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      okToolResult({
        packageName: PACKAGE_NAME,
        serverName: SERVER_NAME,
        version: SERVER_VERSION,
        evidencePolicy: {
          ...EVIDENCE_POLICY,
          requiredStatusFields: [...EVIDENCE_POLICY.requiredStatusFields],
          gates: [...EVIDENCE_POLICY.gates]
        },
        network: SERVER_NETWORK,
        runtime: SERVER_RUNTIME,
        transport: SERVER_TRANSPORT,
        implementedTools: [...IMPLEMENTED_TOOLS],
        implementedToolsCount: IMPLEMENTED_TOOLS.length,
        failClosedTools: [...FAIL_CLOSED_TOOLS],
        resources: {
          count: MCP_RESOURCES.length,
          uris: MCP_RESOURCES.map((resource) => resource.uri),
          items: MCP_RESOURCES.map((resource) => ({
            name: resource.name,
            uri: resource.uri,
            title: resource.title,
            description: resource.description
          }))
        },
        prompts: {
          count: MCP_PROMPTS.length,
          names: MCP_PROMPTS.map((prompt) => prompt.name)
        },
        protocolsTool: TOOL_NAMES.readListSupportedProtocols,
        limitations: [...SERVER_LIMITATIONS]
      })
  );

  server.registerTool(
    TOOL_NAMES.readListSupportedProtocols,
    {
      title: "List supported protocols",
      description: "List current mainnet protocol surfaces and support levels.",
      inputSchema: noParamsInputSchema,
      outputSchema: successOutputSchema({
        protocols: z.array(
          z.object({
            id: z.string(),
            status: z.literal("mainnet"),
            support: z.string()
          })
        )
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      okToolResult({
        protocols: [...SUPPORTED_PROTOCOLS]
      })
  );
}
