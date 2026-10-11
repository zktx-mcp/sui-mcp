import type {
  McpServer,
  RegisteredTool,
  ToolCallback,
  StandardSchemaWithJSON
} from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { TOOL_NAMES, assertValidToolName } from "./toolNames.js";

export type SuiMcpToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export type SuiMcpToolConfig<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined
> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  defaultAnnotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

const DEFAULT_TOOL_ANNOTATIONS = {
  openWorldHint: false
} satisfies ToolAnnotations;

function mergedAnnotations(
  defaultAnnotations: ToolAnnotations | undefined,
  annotations: ToolAnnotations | undefined
): ToolAnnotations {
  return {
    ...DEFAULT_TOOL_ANNOTATIONS,
    ...(defaultAnnotations ?? {}),
    ...(annotations ?? {})
  };
}

export function registerSuiMcpTool<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined
>(
  server: McpServer,
  name: SuiMcpToolName,
  config: SuiMcpToolConfig<OutputArgs, InputArgs>,
  callback: ToolCallback<InputArgs>
): RegisteredTool {
  assertValidToolName(name);
  const { defaultAnnotations, annotations, ...sdkConfig } = config;

  return server.registerTool(
    name,
    {
      ...sdkConfig,
      annotations: mergedAnnotations(defaultAnnotations, annotations)
    },
    callback
  );
}
