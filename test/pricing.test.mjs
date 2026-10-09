import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheSavedOf, costOf, dailyFromCells, loadPrices, lookupPrice } from "../lib/pricing.mjs";

const SONNET = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const table = { models: { "claude-sonnet-5": SONNET, "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } } };

test("cost = tokens × per-million rates, all four token types", () => {
  assert.equal(costOf({ input: 1e6, output: 1e6, cacheCreation: 1e6, cacheRead: 1e6 }, SONNET), 2 + 10 + 2.5 + 0.2);
  assert.equal(costOf({ input: 500_000, output: 0, cacheCreation: 0, cacheRead: 0 }, SONNET), 1);
});

test("price lookup: exact name, then without a -YYYYMMDD suffix, otherwise none", () => {
  assert.equal(lookupPrice("claude-sonnet-5", table), SONNET);
  assert.equal(lookupPrice("claude-haiku-4-5-20251001", table), table.models["claude-haiku-4-5"]);
  assert.equal(lookupPrice("claude-mystery-9", table), null);
  assert.equal(lookupPrice("unknown", table), null);
});

test("dailyFromCells builds the dashboard's daily shape and reports unpriced models instead of hiding them", () => {
  const cells = [
    { date: "2026-10-08", model: "claude-sonnet-5", input: 1e6, output: 0, cacheCreation: 0, cacheRead: 0 },
    { date: "2026-10-08", model: "claude-mystery-9", input: 7, output: 1, cacheCreation: 2, cacheRead: 3 },
    { date: "2026-10-07", model: "claude-haiku-4-5-20251001", input: 0, output: 1e6, cacheCreation: 0, cacheRead: 0 },
  ];
  const { daily, unpriced } = dailyFromCells(cells, table);
  assert.deepEqual(daily.map(d => d.date), ["2026-10-07", "2026-10-08"]);
  assert.deepEqual(unpriced, ["claude-mystery-9"]);
  const d = daily[1];
  assert.equal(d.totalCost, 2); // mystery model contributes $0, flagged separately
  assert.equal(d.totalTokens, 1e6 + 13);
  assert.deepEqual(d.modelsUsed, ["claude-sonnet-5", "claude-mystery-9"]);
  assert.equal(d.modelBreakdowns[1].cost, 0);
  assert.equal(daily[0].totalCost, 5);
});

test("config overrides win over the snapshot; a missing snapshot is an empty table, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccud-price-"));
  const file = join(dir, "prices.json");
  writeFileSync(file, JSON.stringify({ source: "x", fetchedAt: "2026-10-08", models: { "claude-sonnet-5": SONNET } }));
  const merged = loadPrices(file, { "claude-sonnet-5": { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 }, "claude-new": { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } });
  assert.equal(merged.models["claude-sonnet-5"].input, 9);
  assert.ok(merged.models["claude-new"]);
  assert.equal(merged.snapshot.fetchedAt, "2026-10-08");
  assert.deepEqual(loadPrices(join(dir, "missing.json")).models, {});
});

test("cache savings: cache reads would have been input tokens, cache writes would have been cheaper input tokens", () => {
  // SONNET: input 2, cacheRead 0.2, cacheWrite 2.5 (USD per million)
  assert.equal(cacheSavedOf({ cacheRead: 1e6, cacheCreation: 0 }, SONNET), 2 - 0.2, "a million cached reads save the difference to input");
  assert.equal(cacheSavedOf({ cacheRead: 0, cacheCreation: 1e6 }, SONNET), 2 - 2.5, "writing to the cache costs MORE than plain input: negative saving");
  assert.equal(cacheSavedOf({ cacheRead: 4e6, cacheCreation: 1e6 }, SONNET), 4 * 1.8 - 0.5);
  assert.equal(cacheSavedOf({ cacheRead: 0, cacheCreation: 0, input: 5e6, output: 5e6 }, SONNET), 0, "input and output tokens save nothing");
});

test("dailyFromCells carries the estimated cache saving per day and per model, also for cells with a recorded cost; unpriced models save nothing", () => {
  const cells = [
    { date: "2026-10-08", model: "claude-sonnet-5", input: 0, output: 0, cacheCreation: 1e6, cacheRead: 4e6 },
    { date: "2026-10-08", model: "claude-haiku-4-5", input: 0, output: 0, cacheCreation: 0, cacheRead: 1e6, cost: 123 }, // recorded cost: used as is, the saving is still derived
    { date: "2026-10-08", model: "claude-mystery-9", input: 0, output: 0, cacheCreation: 0, cacheRead: 9e6 },
  ];
  const { daily } = dailyFromCells(cells, table);
  const sonnet = 4 * 1.8 - 0.5, haiku = 1 - 0.1;
  assert.equal(daily[0].cacheSaved, sonnet + haiku);
  assert.deepEqual(daily[0].modelBreakdowns.map(b => b.cacheSaved), [sonnet, haiku, 0]);
  assert.equal(daily[0].totalCost > 123, true, "the recorded cost is untouched by the saving");
});

test("cost: cache writes to the 1-hour cache cost 2x input, the rest the 5-minute rate; no 1-hour rate → the 5-minute rate", () => {
  const P = { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 };
  assert.equal(costOf({ input: 0, output: 0, cacheCreation: 1e6, cacheRead: 0 }, P), 2.5, "no TTL info: 5-minute rate (older ledgers)");
  assert.equal(costOf({ input: 0, output: 0, cacheCreation: 1e6, cacheCreation1h: 1e6, cacheRead: 0 }, P), 4);
  assert.equal(costOf({ input: 0, output: 0, cacheCreation: 4e6, cacheCreation1h: 1e6, cacheRead: 0 }, P), 3 * 2.5 + 4, "3M at 5 minutes, 1M at 1 hour");
  assert.equal(costOf({ input: 0, output: 0, cacheCreation: 1e6, cacheCreation1h: 1e6, cacheRead: 0 }, SONNET), 2.5, "a price without cacheWrite1h (config override) falls back");
  assert.equal(costOf({ input: 0, output: 0, cacheCreation: 1e6, cacheCreation1h: 9e6, cacheRead: 0 }, P), 4, "more 1-hour tokens than writes cannot happen; clamped to the writes");
});

test("cache saving: 1-hour writes are priced at the 1-hour rate", () => {
  const P = { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 };
  assert.equal(cacheSavedOf({ cacheRead: 0, cacheCreation: 1e6, cacheCreation1h: 1e6 }, P), 2 - 4);
  assert.equal(cacheSavedOf({ cacheRead: 0, cacheCreation: 2e6, cacheCreation1h: 1e6 }, P), (2 - 2.5) + (2 - 4));
});
