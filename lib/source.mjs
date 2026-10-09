import { EMPTY_TIME, loadHistory, mergeBuckets, mergeTime, saveHistory } from "./history.mjs";
import { bucketDate, bucketsToCells, bucketsToProjectCells } from "./logs.mjs";
import { normalizeDaily } from "./normalize.mjs";
import { costOf, dailyFromCells, lookupPrice } from "./pricing.mjs";

export const SOURCES = ["auto", "logs", "ccusage"];

// active seconds per local day (all projects united) and per day × project, from the 15-minute buckets
function timePayload(time, idleMinutes, withProjects) {
  const days = new Map();
  for (const r of time.all) days.set(bucketDate(r.t), (days.get(bucketDate(r.t)) ?? 0) + r.seconds);
  const byProject = new Map();
  if (withProjects) {
    for (const r of time.projects) {
      const k = `${bucketDate(r.t)}\t${r.project}`;
      byProject.set(k, (byProject.get(k) ?? 0) + r.seconds);
    }
  }
  return {
    idleMinutes,
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)),
    projects: [...byProject.entries()].map(([k, seconds]) => [...k.split("\t"), seconds]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  };
}
const unpricedModels = cells => [...new Set(cells.filter(c => c.unpriced).map(c => c.model))].sort();

// source: "logs"    – read Claude Code transcripts ourselves (needs no ccusage)
//         "ccusage" – shell out to ccusage
//         "auto"    – logs (plus the history ledger) when there is any usage, otherwise ccusage
// getPrices(opts) resolves the price table lazily (the ccusage source never touches the network for prices).
// history: { enabled, path, reset, now } — see history.mjs: the ledger keeps usage AND its cost as priced when first seen.
export async function loadDaily({ source = "auto", readLogs, fetchCcusage, getPrices, history = { enabled: false }, projects = { enabled: false }, time = { enabled: false }, log = () => {} }) {
  if (source !== "ccusage") {
    const read = readLogs();
    const { stats } = read;
    const fresh = read.buckets ?? [];
    const ledger = !history.enabled ? { buckets: [], time: EMPTY_TIME, status: "absent" } : history.reset ? { buckets: [], time: EMPTY_TIME, status: "ok" } : loadHistory(history.path, log);

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
      // active time merges like the tokens (per-field maximum); with the ledger off it is just what the logs show now
      const freshTime = read.time ?? EMPTY_TIME;
      const mergedTime = history.enabled ? mergeTime(ledger.time, freshTime) : { time: freshTime, changed: false };
      if (history.enabled && (merged.changed || mergedTime.changed || history.reset) && ledger.status !== "newer") saveHistory(history.path, merged.buckets, history.now, mergedTime.time);

      const { daily, unpriced } = dailyFromCells(cells, prices.table);
      // day × project × model rows for the whole history (Today and Projects tabs); null when project names are switched off
      const projectRows = projects.enabled ? bucketsToProjectCells(merged.buckets) : null;
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
      return { daily, unpriced, source: "logs", prices: { asOf, origin, ageDays, refreshFailed }, history: historyInfo, projects: projectRows, time: time.enabled ? timePayload(mergedTime.time, time.idleMinutes, projects.enabled) : null };
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
  return { daily: normalizeDaily(fetchCcusage()), unpriced: [], source: "ccusage", prices: null, history: null, projects: null, time: null };
}
