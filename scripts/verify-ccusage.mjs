#!/usr/bin/env node
// Dev-time tool (not shipped): compares the built-in log reader with ccusage on YOUR local logs, per day and model.
// Usage: node scripts/verify-ccusage.mjs [--ccusage-version 20.0.26]
// (if your npm registry is not npmjs, set npm_config_registry=https://registry.npmjs.org/ for a pinned version)
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDaily } from "../lib/ccusage.mjs";
import { readLogs } from "../lib/logs.mjs";
import { normalizeDaily } from "../lib/normalize.mjs";
import { dailyFromCells, loadPrices } from "../lib/pricing.mjs";

const i = process.argv.indexOf("--ccusage-version");
const spec = i > -1 ? `ccusage@${process.argv[i + 1]}` : "ccusage";
const prices = loadPrices(join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "prices.json"));

const { cells, stats } = readLogs();
const mine = dailyFromCells(cells, prices);
const theirs = normalizeDaily(fetchDaily({ spec }));

const flat = rows => new Map(rows.flatMap(r => r.modelBreakdowns.map(b => [`${r.date}\t${b.modelName}`, b])));
const a = flat(theirs);
const b = flat(mine.daily);
const T = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"];
let tokenExact = 0, costExact = 0, onlyOutputDiffers = 0, maxCost = 0;
const keys = new Set([...a.keys(), ...b.keys()]);
for (const k of keys) {
  const x = a.get(k) ?? { cost: 0, ...Object.fromEntries(T.map(t => [t, 0])) };
  const y = b.get(k) ?? { cost: 0, ...Object.fromEntries(T.map(t => [t, 0])) };
  const diff = T.filter(t => x[t] !== y[t]);
  if (!diff.length) tokenExact++;
  else if (diff.length === 1 && diff[0] === "outputTokens") onlyOutputDiffers++;
  const dc = Math.abs(x.cost - y.cost);
  if (dc <= 1e-6 * Math.max(1, x.cost)) costExact++;
  maxCost = Math.max(maxCost, dc);
}
console.log(`ccusage (${spec}) vs built-in reader — ${stats.files} files, ${stats.records} records, ${stats.duplicates} duplicates ignored`);
console.log(`(day, model) cells: ${keys.size} | tokens exact: ${tokenExact} | cost within 1e-6: ${costExact} | max cost diff: $${maxCost.toFixed(6)}`);
if (mine.unpriced.length) console.log(`models without a price in vendor/prices.json: ${mine.unpriced.join(", ")}`);
if (onlyOutputDiffers) console.log(`note: ${onlyOutputDiffers} cell(s) differ ONLY in output tokens — typical for ccusage <= 18, which keeps the FIRST of the duplicated streaming entries; the built-in reader keeps the final one (as ccusage >= 19 does).`);
process.exit(tokenExact === keys.size && costExact === keys.size ? 0 : 1);
