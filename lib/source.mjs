import { loadHistory, mergeBuckets, saveHistory } from "./history.mjs";
import { bucketsToCells } from "./logs.mjs";
import { normalizeDaily } from "./normalize.mjs";
import { costOf, dailyFromCells, lookupPrice } from "./pricing.mjs";

export const SOURCES = ["auto", "logs", "ccusage"];

const unpricedModels = cells => [...new Set(cells.filter(c => c.unpriced).map(c => c.model))].sort();

// source: "logs"    – read Claude Code transcripts ourselves (needs no ccusage)
//         "ccusage" – shell out to ccusage
//         "auto"    – logs (plus the history ledger) when there is any usage, otherwise ccusage
// getPrices(opts) resolves the price table lazily (the ccusage source never touches the network for prices).
// history: { enabled, path, reset, now } — see history.mjs: the ledger keeps usage AND its cost as priced when first seen.
export async function loadDaily({ source = "auto", readLogs, fetchCcusage, getPrices, history = { enabled: false }, log = () => {} }) {
  if (source !== "ccusage") {
    const read = readLogs();
    const { stats } = read;
    const fresh = read.buckets ?? [];
    const ledger = !history.enabled ? { buckets: [], status: "absent" } : history.reset ? { buckets: [], status: "ok" } : loadHistory(history.path, log);

    if (fresh.length || ledger.buckets.length) {
      // Buckets that are new (or grew) are priced with today's table; buckets already in the ledger keep their recorded cost.
      const assemble = prices => {
        const priceFor = model => lookupPrice(model, prices.table);
        if (history.enabled) return mergeBuckets(ledger.buckets, fresh, priceFor);
        return { changed: false, buckets: fresh.map(b => ({ ...b, cost: priceFor(b.model) ? costOf(b, priceFor(b.model)) : null })) };
      };
      let prices = await getPrices();
      let merged = assemble(prices);
      let cells = bucketsToCells(merged.buckets);
      if (unpricedModels(cells).length) {
        // a model we have no price for may have been added upstream since the last download — try once more
        const again = await getPrices({ wantFresh: true });
        if (again.origin === "refreshed") {
          prices = again;
          merged = assemble(prices);
          cells = bucketsToCells(merged.buckets);
        }
      }
      if (history.enabled && (merged.changed || history.reset) && ledger.status !== "newer") saveHistory(history.path, merged.buckets, history.now);

      const { daily, unpriced } = dailyFromCells(cells, prices.table);
      let historyInfo = null;
      if (history.enabled) {
        const inLogs = new Set(read.cells.map(c => c.date));
        const days = [...new Set(cells.map(c => c.date))].sort();
        historyInfo = { days: days.length, first: days[0] ?? null, restoredDays: days.filter(d => !inLogs.has(d)).length };
      }
      const dup = stats.duplicates ? `, ${stats.duplicates.toLocaleString("en-US")} duplicate streaming entries ignored` : "";
      log(`Data source: Claude Code logs (${stats.files} files, ${stats.records.toLocaleString("en-US")} usage records${dup})`);
      if (historyInfo) log(`History: ${historyInfo.days} days kept in history.json (since ${historyInfo.first})${historyInfo.restoredDays ? `, ${historyInfo.restoredDays} of them no longer in the Claude Code logs` : ""}.`);
      const { asOf, origin, ageDays, refreshFailed } = prices;
      return { daily, unpriced, source: "logs", prices: { asOf, origin, ageDays, refreshFailed }, history: historyInfo };
    }
    if (source === "logs") {
      throw new Error(
        stats.roots.length
          ? `no usage records found under ${stats.roots.join(", ")}`
          : "no Claude Code log directory found (looked for $CLAUDE_CONFIG_DIR, ~/.config/claude/projects, ~/.claude/projects)"
      );
    }
    log("No local usage records found — falling back to ccusage.");
  }
  log("Data source: ccusage");
  return { daily: normalizeDaily(fetchCcusage()), unpriced: [], source: "ccusage", prices: null, history: null };
}
