import { z } from "zod";
import {
  DEEPBOOK_SWAP_ACTION_KIND,
  DEEPBOOK_SWAP_ADAPTER_ID
} from "./deepbook/deepbookSwapIntent.js";

/**
 * One slash-prompt surface contributed by a review adapter.
 *
 * Prompt names follow action-first naming: `<action>-<protocolSlug>`
 * (for example `swap-deep`). Users reach for the verb before the venue, so
 * action-first keeps autocomplete grouped by what the user wants to do. When
 * an action has exactly one registered protocol, the bare action name (for
 * example `swap`) is also registered as a shorthand.
 *
 * The surface carries only protocol-specific copy. Boundary language (no
 * signing data, no transaction bytes, local-review-only signing) is owned by
 * the platform and appended at registration time; adapters cannot weaken it.
 */
export const adapterPromptSurfaceSchema = z
  .object({
    adapterId: z.string().min(1),
    action: z
      .string()
      .regex(/^[a-z][a-z0-9]*$/, "action must be a lowercase slug, e.g. swap"),
    protocolSlug: z
      .string()
      .regex(/^[a-z][a-z0-9]*$/, "protocolSlug must be a lowercase slug, e.g. deep"),
    title: z.string().min(1),
    description: z.string().min(1),
    intentArgDescription: z.string().min(1),
    exampleIntents: z.array(z.string().min(1)).min(1),
    toolName: z.string().min(1)
  })
  .strict();

export type AdapterPromptSurface = z.infer<typeof adapterPromptSurfaceSchema>;

export function promptNameFor(surface: AdapterPromptSurface): string {
  return `${surface.action}-${surface.protocolSlug}`;
}

/**
 * Bare action prompts (`swap`) are always registered. With a single
 * registered protocol they go straight to that protocol; with several they
 * carry an optional `protocol` argument (completion suggests the slugs) and
 * instruct the model to ask the user which protocol to use - never to pick a
 * venue silently.
 */
export function actionGroups(surfaces: readonly AdapterPromptSurface[]): Map<string, AdapterPromptSurface[]> {
  const byAction = new Map<string, AdapterPromptSurface[]>();
  for (const surface of surfaces) {
    byAction.set(surface.action, [...(byAction.get(surface.action) ?? []), surface]);
  }
  return byAction;
}

export const ADAPTER_PROMPT_SURFACES: readonly AdapterPromptSurface[] = [
  {
    adapterId: DEEPBOOK_SWAP_ADAPTER_ID,
    action: DEEPBOOK_SWAP_ACTION_KIND,
    protocolSlug: "deep",
    title: "DeepBook Swap Review",
    description: 'Prepare a reviewable DeepBook mainnet swap from a one-line intent, e.g. "10 sui to usdc".',
    intentArgDescription: 'Swap intent in one line, any language, e.g. "10 sui to usdc" or "10 수이 usdc로 환전"',
    exampleIntents: ["10 sui to usdc", "10 수이 usdc로 환전"],
    toolName: "action_start_review"
  }
];
