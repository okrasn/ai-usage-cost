import { existsSync, readFileSync } from "node:fs";

// Rates are USD per million tokens. Cache-creation tokens are split by the time-to-live Claude Code asked for: the
// 5-minute rate (`cacheWrite`, 1.25x input) and the 1-hour rate (`cacheWrite1h`, 2x input — Anthropic pricing page,
// "Prompt caching", checked 2026-10-09 against all 22 models in vendor/prices.json). A price without a 1-hour rate
// (e.g. a config override) charges those tokens at the 5-minute rate, which is what versions before 1.3 did for all.
export function loadPrices(snapshotPath, overrides = {}) {
  const snap = snapshotPath && existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : { models: {} };
  return { models: { ...snap.models, ...overrides }, snapshot: { source: snap.source, fetchedAt: snap.fetchedAt } };
}

export function lookupPrice(model, table) {
  const m = table.models;
  return m[model] ?? m[model.replace(/-\d{8}$/, "")] ?? null;
}

// `cacheCreation1h` (optional) = how many of the cache-creation tokens were written to the 1-hour cache.
const writes = t => { const h = Math.min(t.cacheCreation1h || 0, t.cacheCreation); return [t.cacheCreation - h, h]; };
export function costOf(t, p) {
  const [w5, w1h] = writes(t);
  return (t.input * p.input + t.output * p.output + w5 * p.cacheWrite + w1h * (p.cacheWrite1h ?? p.cacheWrite) + t.cacheRead * p.cacheRead) / 1e6;
}

// What the prompt cache saved: without it every cache-read and every cache-written token would have been a plain input
// token (cache reads cost far less than input, cache writes a little more). An ESTIMATE at the rates in force now — the
// cost itself is recorded at first sight, this is derived each time.
export function cacheSavedOf(t, p) {
  const [w5, w1h] = writes(t);
  return (t.cacheRead * (p.input - p.cacheRead) + w5 * (p.input - p.cacheWrite) + w1h * (p.input - (p.cacheWrite1h ?? p.cacheWrite))) / 1e6;
}

// cells ({date, model, input, output, cacheCreation, cacheRead, [cost, unpriced]}) → rows in the dashboard's daily shape.
export function dailyFromCells(cells, table) {
  const days = new Map();
  const unpriced = new Set();
  for (const c of cells) {
    // cells that carry a recorded cost (from the history ledger) are used as they are; others are priced with `table`
    const price = lookupPrice(c.model, table);
    let cost;
    if (c.cost !== undefined) {
      cost = c.cost;
      if (c.unpriced) unpriced.add(c.model);
    } else {
      if (!price) unpriced.add(c.model);
      cost = price ? costOf(c, price) : 0;
    }
    let day = days.get(c.date);
    if (!day) {
      day = { date: c.date, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0, cacheSaved: 0, modelsUsed: [], modelBreakdowns: [] };
      days.set(c.date, day);
    }
    day.inputTokens += c.input;
    day.outputTokens += c.output;
    day.cacheCreationTokens += c.cacheCreation;
    day.cacheReadTokens += c.cacheRead;
    day.totalTokens += c.input + c.output + c.cacheCreation + c.cacheRead;
    const saved = price ? cacheSavedOf(c, price) : 0;
    day.totalCost += cost;
    day.cacheSaved += saved;
    day.modelsUsed.push(c.model);
    day.modelBreakdowns.push({ modelName: c.model, cost, inputTokens: c.input, outputTokens: c.output, cacheCreationTokens: c.cacheCreation, cacheReadTokens: c.cacheRead, cacheSaved: saved });
  }
  return { daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), unpriced: [...unpriced].sort() };
}
