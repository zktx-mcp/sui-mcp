import type { McpServer } from "@modelcontextprotocol/server";
import { completable } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  actionGroups,
  promptNameFor,
  type AdapterPromptSurface
} from "../adapters/adapterPromptSurfaces.js";

export const MCP_PROMPTS = [
  {
    name: "inspect-supported-sui-actions",
    title: "Inspect Supported Sui Actions",
    description: "Review current supported mainnet surfaces and tool status.",
    text: [
      "Inspect the Sui MCP server status and supported mainnet Sui protocol surfaces.",
      "Use read.get_server_status first, then read.list_supported_protocols.",
      "Report implemented tools separately from unavailable or blocked surfaces."
    ].join("\n")
  },
  {
    name: "prepare-reviewable-sui-action",
    title: "Prepare Reviewable Sui Action",
    description: "Prepare a local review session for a supported action proposal.",
    text: [
      "Prepare a reviewable Sui action only through Sui MCP's review-session flow.",
      "Use action.prepare_external_proposal_review when the input is a structured external payment or Sui action proposal.",
      "External proposals get read-only local review and never become signing material. Use action.prepare_sui_action_review for a natural-language swap intent; after a wallet account is connected, account-bound review can reach ready_for_wallet_review, where an explicit Review card action can request approval in the user’s wallet through the backend.",
      "Present the internal Review card and summarize the returned review checks. This MCP response never contains signing data, transaction bytes, or signing readiness; only an explicit UI action and wallet approval authorize the backend request; request status is separate from server-verified chain execution facts."
    ].join("\n")
  }
] as const;

// Platform-owned boundary language appended to every adapter prompt surface.
// Adapters contribute copy about their own action only; they cannot weaken
// or omit these lines.
const PLATFORM_PROMPT_BOUNDARY_LINES = [
  "Present the internal Review card and summarize the returned review checks.",
  "This MCP response never contains signing data, transaction bytes, or signing readiness; only an explicit UI action and wallet approval authorize the backend request; request status is separate from server-verified chain execution facts."
];

function surfacePromptText(surface: AdapterPromptSurface, intent: string): string {
  return [
    `Prepare a reviewable Sui mainnet ${surface.action} for this intent: "${intent}".`,
    `Parse the source amount, source symbol, and target symbol from the intent (any language) and call ${surface.toolName} with them and intent.protocol set to "${surface.protocolSlug}".`,
    ...PLATFORM_PROMPT_BOUNDARY_LINES
  ].join("\n");
}

function registerSurfacePrompt(
  server: McpServer,
  name: string,
  surface: AdapterPromptSurface,
  description: string
): void {
  server.registerPrompt(
    name,
    {
      title: surface.title,
      description,
      argsSchema: {
        intent: z.string().describe(surface.intentArgDescription)
      }
    },
    async ({ intent }) => ({
      description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: surfacePromptText(surface, intent)
          }
        }
      ]
    })
  );
}

export function registerMcpPrompts(server: McpServer, surfaces: readonly AdapterPromptSurface[] = []): void {
  for (const prompt of MCP_PROMPTS) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description
      },
      async () => ({
        description: prompt.description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: prompt.text
            }
          }
        ]
      })
    );
  }

  // Adapter prompt surfaces: action-first names (`swap-deep`) with one
  // free-text intent argument so clients can pass the whole request in one
  // line (Claude Code: /mcp__sui-mcp__swap-deep 10 sui to usdc;
  // Claude Desktop shows a single input field). The model parses the
  // intent; this server never does.
  for (const surface of surfaces) {
    registerSurfacePrompt(server, promptNameFor(surface), surface, surface.description);
  }
  // Bare action prompts are always registered. One protocol: straight to it.
  // Several protocols: an optional `protocol` argument (completion suggests
  // the slugs) and explicit instructions to ask the user - the venue is the
  // user's choice, never the server's.
  for (const [action, group] of actionGroups(surfaces)) {
    registerBareActionPrompt(server, action, group);
  }
}

export function bareActionPromptText(
  action: string,
  group: readonly AdapterPromptSurface[],
  intent: string,
  protocol?: string
): string {
  const chosen =
    group.length === 1 ? group[0] : group.find((surface) => surface.protocolSlug === (protocol ?? "").trim());
  if (chosen) {
    return surfacePromptText(chosen, intent);
  }
  const options = group
    .map((surface) => `${surface.protocolSlug} (${surface.title}, tool: ${surface.toolName})`)
    .join("; ");
  return [
    `Several protocols support the ${action} action: ${options}.`,
    `The user's intent: "${intent}".`,
    "List these protocol options to the user and ask which one to use. Do not pick a protocol on your own.",
    "Once the user names a protocol, parse the source amount, source symbol, and target symbol from the intent (any language) and call that protocol's tool with them and intent.protocol set to the chosen slug.",
    ...PLATFORM_PROMPT_BOUNDARY_LINES
  ].join("\n");
}

function registerBareActionPrompt(server: McpServer, action: string, group: readonly AdapterPromptSurface[]): void {
  const single = group.length === 1 ? group[0] : undefined;
  const first = group[0];
  if (!first) {
    return;
  }
  const description = single
    ? `${single.description} Shorthand for ${promptNameFor(single)}.`
    : `Prepare a reviewable Sui ${action} - several protocols support it (${group
        .map((surface) => surface.protocolSlug)
        .join(", ")}); you pick which.`;
  const slugs = group.map((surface) => surface.protocolSlug);
  server.registerPrompt(
    action,
    {
      title: single ? single.title : `${action} (choose protocol)`,
      description,
      argsSchema: {
        intent: completable(z.string().describe(first.intentArgDescription), (value) =>
          value ? [] : group.flatMap((surface) => surface.exampleIntents)
        ),
        ...(single
          ? {}
          : {
              protocol: completable(
                z.string().optional().describe(`Protocol slug (optional): ${slugs.join(" | ")}`),
                (value) => slugs.filter((slug) => slug.startsWith((value ?? "").toLowerCase()))
              )
            })
      }
    },
    async (args) => ({
      description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: bareActionPromptText(action, group, String(args.intent ?? ""),
              typeof args.protocol === "string" ? args.protocol : undefined)
          }
        }
      ]
    })
  );
}
