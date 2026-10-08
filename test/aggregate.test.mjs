import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPeriods, localeFirstDay, resolveWeekStart, weekStartOf } from "../lib/aggregate.mjs";
import { normalizeDaily } from "../lib/normalize.mjs";
import { classicRow } from "./helpers.mjs";

// 2026-10-08 is a Thursday.
test("weekStartOf honours the first day of the week", () => {
  assert.equal(weekStartOf("2026-10-08", 0), "2026-10-04"); // Sunday start
  assert.equal(weekStartOf("2026-10-08", 1), "2026-10-05"); // Monday start
  assert.equal(weekStartOf("2026-10-08", 6), "2026-10-03"); // Saturday start
  assert.equal(weekStartOf("2026-10-04", 0), "2026-10-04"); // a start day maps to itself
  assert.equal(weekStartOf("2026-10-01", 0), "2026-09-27"); // week spans a month boundary
  assert.equal(weekStartOf("2026-01-01", 1), "2025-12-29"); // ... and a year boundary
});

test("resolveWeekStart: explicit names win, 'auto' follows the locale", () => {
  assert.equal(resolveWeekStart("monday"), 1);
  assert.equal(resolveWeekStart("Sunday"), 0);
  assert.equal(resolveWeekStart("auto", "en-US"), 0);
  assert.equal(resolveWeekStart("auto", "de-DE"), 1);
  assert.equal(localeFirstDay("not a locale!!"), 1); // invalid locale → ISO Monday
});

test("weekly and monthly rows are sums of the daily rows, per model", () => {
  const daily = normalizeDaily({
    daily: [
      classicRow("2026-09-30", 1, { a: 1 }),
      classicRow("2026-10-01", 2, { a: 0.5, b: 0.5 }),
      classicRow("2026-10-05", 4, { b: 1 }),
    ],
  });
  const p = buildPeriods(daily, { weekStart: "monday" });
  assert.deepEqual(p.weekly.map(w => w.week), ["2026-09-28", "2026-10-05"]);
  assert.deepEqual(p.monthly.map(m => m.month), ["2026-09", "2026-10"]);

  const oct = p.monthly[1];
  assert.equal(oct.totalCost, 6);
  assert.equal(oct.totalTokens, 200);
  assert.deepEqual(oct.modelsUsed.sort(), ["a", "b"]);
  const cost = Object.fromEntries(oct.modelBreakdowns.map(b => [b.modelName, b.cost]));
  assert.deepEqual(cost, { a: 1, b: 5 });
  assert.equal(p.weekly[0].totalCost, 3); // 09-30 + 10-01 fall in the week of 09-28
  assert.equal(p.weekStartDay, "monday");
});
