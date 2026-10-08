import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDaily } from "../lib/normalize.mjs";
import { classicRow, periodRow } from "./helpers.mjs";

test("classic and period-keyed rows normalize to the same shape", () => {
  const a = normalizeDaily({ daily: [classicRow("2026-10-01", 2)] });
  const b = normalizeDaily({ daily: [periodRow("2026-10-01", 2)] });
  assert.deepEqual(a, b);
  assert.equal(a[0].date, "2026-10-01");
  assert.equal(a[0].modelBreakdowns[0].modelName, "claude-sonnet-5");
});

test("rows are sorted ascending by date", () => {
  const rows = normalizeDaily({ daily: [classicRow("2026-10-03", 1), classicRow("2026-10-01", 1)] });
  assert.deepEqual(rows.map(r => r.date), ["2026-10-01", "2026-10-03"]);
});

test("missing totalTokens is derived; missing breakdowns degrade to empty", () => {
  const raw = { ...classicRow("2026-10-01", 1) };
  delete raw.totalTokens;
  delete raw.modelBreakdowns;
  const [r] = normalizeDaily({ daily: [raw] });
  assert.equal(r.totalTokens, 100);
  assert.deepEqual(r.modelBreakdowns, []);
});

test("shape changes fail loudly instead of rendering a $0 dashboard", () => {
  assert.throws(() => normalizeDaily({ weekly: [] }), /no "daily" array/);
  assert.throws(() => normalizeDaily(null), /no "daily" array/);
  assert.throws(() => normalizeDaily({ daily: [{ day: "2026-10-01" }] }), /daily row 0/);
  assert.throws(() => normalizeDaily({ daily: [{ date: "01/10/2026" }] }), /daily row 0/);
});

test("empty history is valid", () => {
  assert.deepEqual(normalizeDaily({ daily: [] }), []);
});
