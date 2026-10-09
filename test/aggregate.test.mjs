import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPeriods, localeFirstDay, resolveWeekStart, weekKeyWithinYear, weekStartOf } from "../lib/aggregate.mjs";
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

test("a week that crosses New Year is split into two rows, one per year, so yearly totals agree across tabs", () => {
  const daily = normalizeDaily({ daily: [classicRow("2025-12-29", 1), classicRow("2025-12-31", 2), classicRow("2026-01-01", 4), classicRow("2026-01-04", 8), classicRow("2026-01-05", 16)] });
  const monday = buildPeriods(daily, { weekStart: "monday" });
  assert.deepEqual(monday.weekly.map(w => [w.week, w.totalCost]), [["2025-12-29", 3], ["2026-01-01", 12], ["2026-01-05", 16]]);
  const sunday = buildPeriods(daily, { weekStart: "sunday" });
  // Sunday-start: the week of 2025-12-28 runs to 2026-01-03 (split at New Year); 2026-01-04 starts a new week
  assert.deepEqual(sunday.weekly.map(w => [w.week, w.totalCost]), [["2025-12-28", 3], ["2026-01-01", 4], ["2026-01-04", 24]]);

  for (const p of [monday, sunday]) {
    for (const year of ["2025", "2026"]) {
      const sum = rows => rows.filter(r => (r.week ?? r.month ?? r.date).startsWith(year)).reduce((s, r) => s + r.totalCost, 0);
      assert.equal(sum(p.weekly), sum(p.daily), `${year}: weekly = daily`);
      assert.equal(sum(p.monthly), sum(p.daily), `${year}: monthly = daily`);
    }
  }
});

test("weekKeyWithinYear leaves ordinary weeks alone and a week that starts on Jan 1 unsplit", () => {
  assert.equal(weekKeyWithinYear("2026-10-08", 1), "2026-10-05");
  assert.equal(weekKeyWithinYear("2026-01-01", 4), "2026-01-01"); // Thursday: the week starts on Jan 1 itself
  assert.equal(weekKeyWithinYear("2026-01-03", 4), "2026-01-01");
  assert.equal(weekKeyWithinYear("2026-01-01", 1), "2026-01-01"); // Thursday in a Monday-start week that began in 2025
  assert.equal(weekKeyWithinYear("2025-12-31", 1), "2025-12-29");
  assert.equal(weekKeyWithinYear("2024-02-29", 0), "2024-02-25"); // leap day, no split
});

test("weekly and monthly rows add up the estimated cache saving of their days (rows without one count as 0)", () => {
  const rows = normalizeDaily({ daily: [classicRow("2026-10-05", 1), classicRow("2026-10-06", 1), classicRow("2026-09-30", 1)] });
  rows.find(r => r.date === "2026-10-05").cacheSaved = 1.5;
  rows.find(r => r.date === "2026-10-06").cacheSaved = 2;
  const p = buildPeriods(rows, { weekStart: "monday" });
  assert.deepEqual(p.monthly.map(m => m.cacheSaved), [0, 3.5], "September has none, October 1.5 + 2");
  assert.deepEqual(p.weekly.map(w => w.cacheSaved), [0, 3.5]);
});
