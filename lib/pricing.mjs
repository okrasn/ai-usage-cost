import { existsSync, readFileSync } from "node:fs";

// Rates are USD per million tokens. The 5-minute cache-write rate (`cacheWrite`) is applied to every cache-creation
// token, exactly like ccusage does; the 1-hour rate (`cacheWrite1h`) is kept in the snapshot but deliberately unused
// until it is confirmed against official pricing.
export function loadPrices(snapshotPath, overrides = {}) {
  const snap = snapshotPath && existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : { models: {} };
  return { models: { ...snap.models, ...overrides }, snapshot: { source: snap.source, fetchedAt: snap.fetchedAt } };
}

export function lookupPrice(model, table) {
  const m = table.models;
  return m[model] ?? m[model.replace(/-\d{8}$/, "")] ?? null;
}

export const costOf = (t, p) => (t.input * p.input + t.output * p.output + t.cacheCreation * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;

// cells ({date, model, input, output, cacheCreation, cacheRead, [cost, unpriced]}) → rows in the dashboard's daily shape.
export function dailyFromCells(cells, table) {
  const days = new Map();
  const unpriced = new Set();
  for (const c of cells) {
    // cells that carry a recorded cost (from the history ledger) are used as they are; others are priced with `table`
    let cost;
    if (c.cost !== undefined) {
      cost = c.cost;
      if (c.unpriced) unpriced.add(c.model);
    } else {
      const price = lookupPrice(c.model, table);
      if (!price) unpriced.add(c.model);
      cost = price ? costOf(c, price) : 0;
    }
    let day = days.get(c.date);
    if (!day) {
      day = { date: c.date, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, totalCost: 0, modelsUsed: [], modelBreakdowns: [] };
      days.set(c.date, day);
    }
    day.inputTokens += c.input;
    day.outputTokens += c.output;
    day.cacheCreationTokens += c.cacheCreation;
    day.cacheReadTokens += c.cacheRead;
    day.totalTokens += c.input + c.output + c.cacheCreation + c.cacheRead;
    day.totalCost += cost;
    day.modelsUsed.push(c.model);
    day.modelBreakdowns.push({ modelName: c.model, cost, inputTokens: c.input, outputTokens: c.output, cacheCreationTokens: c.cacheCreation, cacheReadTokens: c.cacheRead });
  }
  return { daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), unpriced: [...unpriced].sort() };
}
