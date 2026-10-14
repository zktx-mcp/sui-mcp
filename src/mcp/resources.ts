import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const MCP_RESOURCES = [
  {
    name: "readme",
    uri: "suimcp://docs/readme",
    title: "README",
    description: "Public entry document: product purpose, current release boundary, setup path, and documentation map.",
    path: "README.md"
  },
  {
    name: "mcp-setup",
    uri: "suimcp://docs/mcp-setup",
    title: "MCP Setup",
    description: "Setup guide: installation, MCP client connection, first-use flow, settings, and troubleshooting.",
    path: "docs/MCP_SETUP.md"
  },
  {
    name: "mcp-tools",
    uri: "suimcp://docs/mcp-tools",
    title: "MCP Tools",
    description: "API reference: tool contracts, response fields, statuses, follow-up fields, and output boundaries.",
    path: "docs/MCP_TOOLS.md"
  },
  {
    name: "wallet-connection",
    uri: "suimcp://docs/wallet-connection",
    title: "Wallet Connection",
    description: "Wallet connection reference: active read context, private SDK ownership and user-approved transaction requests.",
    path: "docs/WALLET_CONNECTION.md"
  },
  {
    name: "agent-behavior",
    uri: "suimcp://docs/agent-behavior",
    title: "Agent Behavior Reference",
    description: "Answer playbook: user-question flows, tool selection, and response wording boundaries.",
    path: "docs/AGENT_BEHAVIOR.md"
  },
  {
    name: "deepbook-v3",
    uri: "suimcp://protocols/deepbook-v3",
    title: "DeepBookV3",
    description: "Protocol reference only; use MCP tool responses and read_list_supported_protocols for current support.",
    path: "protocols/deepbook-v3.md"
  },
  {
    name: "deepbook-margin",
    uri: "suimcp://protocols/deepbook-margin",
    title: "DeepBook Margin",
    description: "Protocol reference only; no margin MCP read tools or signable actions are exposed in this release.",
    path: "protocols/deepbook-margin.md"
  }
] as const;

export function registerMcpResources(server: McpServer): void {
  for (const resource of MCP_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: "text/markdown"
      },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: "text/markdown",
            text: await readFile(resolve(packageRoot, resource.path), "utf8")
          }
        ]
      })
    );
  }
}
