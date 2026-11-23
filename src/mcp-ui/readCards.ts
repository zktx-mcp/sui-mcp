import type { CardRecordStore } from "../core/session/cardSession.js";
import type { SuiReadService } from "../core/read/readService.js";
import type { readPublicChainReceipt } from "../core/action/suiChainReceiptReader.js";
import type { createDeepbookUsdcChartService } from "../core/read/deepbookUsdcChartService.js";
import { CardStore } from "../core/session/cardSessionStore.js";
import type { Logger } from "../runtime/logger.js";
import type { WalletWorkflow } from "../core/session/walletWorkflow.js";
import type { SettingsWorkflow } from "../core/session/settingsWorkflow.js";

export function createCardStore(options: {
  records: CardRecordStore;
  ownerId: string;
  readService: Pick<SuiReadService, "summarizeAccountInventory">;
  publicChainReceiptReader: (input: Parameters<typeof readPublicChainReceipt>[1]) => ReturnType<typeof readPublicChainReceipt>;
  chart: ReturnType<typeof createDeepbookUsdcChartService>;
  assertCurrent?: (() => void) | undefined;
  now?: (() => Date) | undefined;
  logger?: Logger | undefined;
  workflow?: WalletWorkflow | undefined;
  settings?: SettingsWorkflow | undefined;
}): CardStore {
  return new CardStore({
    records: options.records, ownerId: options.ownerId, assertCurrent: options.assertCurrent, now: options.now, logger: options.logger, workflow: options.workflow, settings: options.settings,
    prepare: async (kind) => {
      if (kind !== "chart") return { status: "ready" };
      const choices = await options.chart.getPools();
      if (choices.status === "source_unavailable" && choices.reason === "pool_list_incomplete" && choices.candidates?.length) {
        const reasons = choices.candidates.map(market => market.unavailableReason ? market.poolId + " (" + market.unavailableReason + ")" : market.poolId).join(", ");
        return { status: "failed", error: "No chart markets could be verified. " + reasons };
      }
      return choices.status === "ok" ? { status: "ready", data: choices } : {
        status: "failed", error: "The chart's available trading pairs could not be loaded."
      };
    },
    execute: async (selection, market, preview) => {
      const { kind, input } = selection;
      if (kind === "account") return options.readService.summarizeAccountInventory(input);
      if (kind === "receipt") {
        const result = await options.publicChainReceiptReader({ ...input, now: options.now?.() ?? new Date() });
        if (result.status === "unavailable" || result.status === "invalid_digest") throw new Error("Receipt source unavailable.");
        return result;
      }
      return options.chart.readCandles(selection.prepared, market, preview);
    }
  });
}
