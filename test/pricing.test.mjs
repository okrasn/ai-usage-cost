import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costOf, dailyFromCells, loadPrices, lookupPrice } from "../lib/pricing.mjs";

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
