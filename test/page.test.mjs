import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { buildPeriods } from "../lib/aggregate.mjs";
import { normalizeDaily } from "../lib/normalize.mjs";
import { renderHtml } from "../lib/render.mjs";
import { classicRow } from "./helpers.mjs";

// Runs the REAL page script from template.html against a tiny fake DOM, with a fixed "now",
// so the numbers shown on each tab can be asserted.
const TEMPLATE = readFileSync(new URL("../template.html", import.meta.url), "utf8");
const NOW = new Date(2026, 9, 8, 12, 0, 0); // local 2026-10-08

function openPage(dailyRows) {
  const daily = normalizeDaily({ daily: dailyRows });
  const periods = buildPeriods(daily, { weekStart: "monday" });
  const html = renderHtml(TEMPLATE, { daily: periods.daily, weekly: periods.weekly, monthly: periods.monthly, generatedAt: NOW.toISOString(), unpriced: [] }, "Tester", "");
  const start = html.indexOf("<script>\nconst DATA");
  const script = html.slice(start + "<script>\n".length, html.indexOf("</script>", start));

  const nodes = new Map();
  const makeEl = () => {
    const attrs = {};
    const el = { textContent: "", value: "", hidden: false, disabled: false, style: {}, dataset: {}, className: "", children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k] ?? null,
      appendChild(c) { this.children.push(c); } };
    let inner = "";
    Object.defineProperty(el, "innerHTML", { get: () => inner, set: v => { inner = v; if (v === "") el.children = []; } });
    return el;
  };
  const byId = id => { if (!nodes.has(id)) nodes.set(id, makeEl()); return nodes.get(id); };
  const tbody = makeEl();
  const document = {
    getElementById: byId,
    querySelector: sel => (sel === "#tbl tbody" ? tbody : null),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    documentElement: makeEl(),
  };
  class FakeDate extends Date {
    constructor(...a) { a.length ? super(...a) : super(NOW.getTime()); }
  }
  class FakeChart { constructor(canvas, cfg) { this.cfg = cfg; } destroy() {} }
  const ctx = vm.createContext({ document, Date: FakeDate, Chart: FakeChart, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(script, ctx);

  const text = id => byId(id).textContent;
  return {
    show(view) { vm.runInContext(`render(${JSON.stringify(view)})`, ctx); },
    cards: () => ({ min: [text("kpi-min-label"), text("kpi-min")], avg: [text("kpi-avg-label"), text("kpi-avg")], max: [text("kpi-max-label"), text("kpi-max")] }),
    rows: () => tbody.children,
  };
}

const D = (date, cost) => classicRow(date, cost);
// 2026-10-08 is a Thursday; the Today window is 2026-09-09 … 2026-10-08
const DATA = [D("2026-08-30", 500), D("2026-09-08", 300), D("2026-09-09", 9), D("2026-09-10", 0.35), D("2026-09-20", 12), D("2026-10-01", 4.5), D("2026-10-08", 40)];

test("Daily tab: min / avg / max over every row of the table, with the date of the extremes", () => {
  const p = openPage(DATA);
  p.show("daily");
  const c = p.cards();
  assert.deepEqual(c.min, ["Min cost / day · 2026-09-10", "$0.35"]);
  assert.deepEqual(c.max, ["Max cost / day · 2026-08-30", "$500.00"]);
  const avg = (500 + 300 + 9 + 0.35 + 12 + 4.5 + 40) / 7;
  assert.deepEqual(c.avg, ["Avg cost / day · 7 days", `$${avg.toFixed(2)}`]);
});

test("Weekly and Monthly tabs use their own rows (week start date / month in the label)", () => {
  const p = openPage(DATA);
  p.show("weekly");
  let c = p.cards();
  // Monday-start weeks: 08-24 (500+… only 08-30 → 500), 09-07 (300+9+0.35 = 309.35), 09-14 none, 09-14… 09-21 week has 09-20 → 09-14 week (12), 09-28 week (4.5), 10-05 week (40)
  assert.deepEqual(c.min, ["Min cost / week · 2026-09-28", "$4.50"]);
  assert.deepEqual(c.max, ["Max cost / week · 2026-08-24", "$500.00"]);
  assert.match(c.avg[0], /^Avg cost \/ week · 5 weeks$/);
  p.show("monthly");
  c = p.cards();
  assert.deepEqual(c.min, ["Min cost / month · 2026-10", "$44.50"]);
  assert.deepEqual(c.max, ["Max cost / month · 2026-08", "$500.00"]);
  assert.equal(c.avg[0], "Avg cost / month · 3 months");
});

test("Today tab: min / avg / max over the last 30 calendar days (days with usage), not just today", () => {
  const p = openPage(DATA);
  p.show("today");
  const c = p.cards();
  // in the window: 09-09 (9), 09-10 (0.35), 09-20 (12), 10-01 (4.5), 10-08 (40); 08-30 and 09-08 are older than 30 days
  assert.deepEqual(c.min, ["Min cost / day · 2026-09-10", "$0.35"]);
  assert.deepEqual(c.max, ["Max cost / day · 2026-10-08", "$40.00"]);
  assert.deepEqual(c.avg, ["Avg cost / day · 5 of last 30 days", `$${((9 + 0.35 + 12 + 4.5 + 40) / 5).toFixed(2)}`]);
});

test("Today tab: the window includes today even when it is the only day, and is empty-safe", () => {
  const only = openPage([D("2026-10-08", 7)]);
  only.show("today");
  assert.deepEqual(only.cards().min, ["Min cost / day · 2026-10-08", "$7.00"]);
  const old = openPage([D("2026-01-02", 7)]);
  old.show("today");
  assert.deepEqual(old.cards().min, ["Min cost / day", "—"]);
  assert.deepEqual(old.cards().avg, ["Avg cost / day", "—"]);
});

test("ties show the earliest row", () => {
  const p = openPage([D("2026-09-02", 5), D("2026-09-03", 5), D("2026-09-04", 9)]);
  p.show("daily");
  assert.equal(p.cards().min[0], "Min cost / day · 2026-09-02");
});

test("the table starts with a Total row that sums the columns of the rows below it", () => {
  const p = openPage(DATA);
  p.show("daily");
  const [total, ...rest] = p.rows();
  assert.equal(total.className, "total");
  assert.equal(rest.length, 7);
  assert.equal(total.innerHTML.match(/<td>([^<]*)<\/td>/)[1], "Total", "the label is just Total — the count lives in the Avg card");
  assert.match(total.innerHTML, /\$865\.85/); // 500+300+9+0.35+12+4.5+40
  // 7 rows × (input 10, output 20, cache write 30, cache read 40) — every column is summed, in order
  const cols = [...total.innerHTML.matchAll(/<td class="num">([^<]*)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(cols, ["$865.85", "70", "140", "210", "280"]);
  p.show("monthly");
  assert.equal(p.rows()[0].innerHTML.match(/<td>([^<]*)<\/td>/)[1], "Total");
});

test("Today tab: a row dated after today (clock or time-zone skew) is not part of the 30-day window", () => {
  const p = openPage([D("2026-10-08", 40), D("2026-10-09", 1000)]);
  p.show("today");
  assert.deepEqual(p.cards().max, ["Max cost / day · 2026-10-08", "$40.00"]);
  assert.equal(p.cards().avg[0], "Avg cost / day · 1 of last 30 days");
});
