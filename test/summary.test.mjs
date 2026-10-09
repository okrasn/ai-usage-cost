import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDaily } from "../lib/normalize.mjs";
import { buildSummary } from "../lib/summary.mjs";
import { classicRow } from "./helpers.mjs";

const now = new Date(2026, 9, 8, 12, 0, 0); // local 2026-10-08

test("'Last 7 days' is exactly 7 calendar days including today", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-08"]; // 10-01 is 7 days back → excluded
  const daily = normalizeDaily({ daily: dates.map(d => classicRow(d, 1)) });
  const md = buildSummary(daily, now);
  assert.match(md, /\| Last 7 days \| \$2\.00 \| 200 \|/);
  assert.match(md, /\| Today \(2026-10-08\) \| \$1\.00 \| 100 \|/);
  assert.match(md, /\| This month \(2026-10\) \| \$3\.00 \| 300 \|/);
  assert.match(md, /\| All time \| \$3\.00 \| 300 \|/);
});

test("empty history prints zeros and no model table", () => {
  const md = buildSummary([], now);
  assert.match(md, /\| Today \(2026-10-08\) \| \$0\.00 \| 0 \|/);
  assert.ok(!md.includes("Top models"));
});

test("top models are shortened and ordered by cost", () => {
  const daily = normalizeDaily({
    daily: [classicRow("2026-10-08", 10, { "claude-sonnet-5-20250929": 0.2, "claude-opus-5": 0.8 })],
  });
  const md = buildSummary(daily, now);
  assert.ok(md.indexOf("| opus-5 |") < md.indexOf("| sonnet-5 |"));
});

test("the heading names the tool the summary is about (Claude Code by default)", () => {
  assert.match(buildSummary([], new Date(2026, 9, 8)), /^\n## Claude Code usage — quick summary\n/);
  assert.match(buildSummary([], new Date(2026, 9, 8), { label: "Google Gemini" }), /\n## Google Gemini usage — quick summary\n/);
  assert.doesNotMatch(buildSummary([], new Date(2026, 9, 8)), /Claude Usage/);
});
