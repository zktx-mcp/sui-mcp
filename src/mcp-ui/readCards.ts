import type { CardRecordStore } from "../core/session/cardSession.js";
import type { SuiReadService } from "../core/read/readService.js";
import type { readPublicChainReceipt } from "../core/action/suiChainReceiptReader.js";
import type { createDeepbookUsdcChartService } from "../core/read/deepbookUsdcChartService.js";
import { CardStore } from "../core/session/cardSessionStore.js";
import { accountInputSchema, receiptInputSchema, chartInputSchema } from "../core/read/readCardInputs.js";
import type { Logger } from "../runtime/logger.js";
import type { WalletWorkflow } from "../core/session/walletWorkflow.js";
import type { SettingsWorkflow } from "../core/session/settingsWorkflow.js";

export function createReadCardStore(options: {
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
      return choices.status === "ok" ? { status: "ready", data: choices } : {
        status: "failed", error: "The chart's available trading pairs could not be loaded."
      };
    },
    execute: async (kind, input) => {
      if (kind === "account") return options.readService.summarizeAccountInventory(accountInputSchema.parse(input));
      if (kind === "receipt") {
        const result = await options.publicChainReceiptReader({ ...receiptInputSchema.parse(input), now: options.now?.() ?? new Date() });
        if (result.status === "unavailable" || result.status === "invalid_digest") throw new Error("Receipt source unavailable.");
        return result;
      }
      const query = chartInputSchema.parse(input);
      return options.chart.getCandles(new URLSearchParams(Object.entries(query)
        .filter((entry) => entry[1] !== undefined).map(([key, value]) => [key, String(value)])));
    }
  });
}
