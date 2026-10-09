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

function openPage(dailyRows, { projects, time, generatedAt = NOW.toISOString() } = {}) {
  const daily = normalizeDaily({ daily: dailyRows });
  const measured = new Map(time?.days ?? []); // what build.mjs does: each day's active seconds ride on its row
  for (const row of daily) if (measured.has(row.date)) row.activeSeconds = measured.get(row.date);
  const periods = buildPeriods(daily, { weekStart: "monday" });
  const html = renderHtml(TEMPLATE, { daily: periods.daily, weekly: periods.weekly, monthly: periods.monthly, generatedAt, unpriced: [], ...(projects ? { projects } : {}), ...(time ? { time } : {}) }, "Tester", "");
  const start = html.indexOf("<script>\nconst DATA");
  const script = html.slice(start + "<script>\n".length, html.indexOf("</script>", start));

  const nodes = new Map();
  const makeEl = () => {
    const attrs = {};
    const flags = new Set();
    const handlers = {};
    const el = { textContent: "", value: "", hidden: false, disabled: false, style: {}, dataset: {}, className: "", children: [], handlers,
      classList: { add: c => flags.add(c), remove: c => flags.delete(c), toggle: (c, force) => ((force ?? !flags.has(c)) ? flags.add(c) : flags.delete(c)), contains: c => flags.has(c) },
      addEventListener: (type, fn) => { handlers[type] = fn; }, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k] ?? null,
      appendChild(c) { this.children.push(c); } };
    let inner = "";
    Object.defineProperty(el, "innerHTML", { get: () => inner, set: v => { inner = v; if (v === "") el.children = []; } });
    return el;
  };
  const byId = id => { if (!nodes.has(id)) nodes.set(id, makeEl()); return nodes.get(id); };
  const tbody = makeEl();
  const tabs = ["today", "daily", "weekly", "monthly", "projects"].map(v => { const t = makeEl(); t.dataset.view = v; return t; });
  tabs[0].classList.add("active");
  const chips = ["1d", "7d", "30d", "90d", "1y", "all"].map(r => { const c = makeEl(); c.dataset.range = r; return c; });
  chips.find(c => c.dataset.range === "all").classList.add("active");
  const document = {
    getElementById: byId,
    querySelector: sel => (sel === "#tbl tbody" ? tbody : sel === ".tab.active" ? tabs.find(t => t.classList.contains("active")) ?? null : null),
    querySelectorAll: sel => (sel === ".tab" ? tabs : sel === ".chip" ? chips : []),
    createElement: () => makeEl(),
    documentElement: makeEl(),
  };
  class FakeDate extends Date {
    constructor(...a) { a.length ? super(...a) : super(NOW.getTime()); }
  }
  const charts = {};
  class FakeChart { constructor(canvas, cfg) { charts[cfg.type] = cfg; } destroy() {} }
  const ctx = vm.createContext({ document, Date: FakeDate, Chart: FakeChart, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(script, ctx);

  const text = id => byId(id).textContent;
  return {
    show(view) { vm.runInContext(`render(${JSON.stringify(view)})`, ctx); },
    cards: () => ({ min: [text("kpi-min-label"), text("kpi-min")], avg: [text("kpi-avg-label"), text("kpi-avg")], max: [text("kpi-max-label"), text("kpi-max")] }),
    rows: () => tbody.children,
    // user actions, through the handlers the page registered itself
    clickTab: view => tabs.find(t => t.dataset.view === view).handlers.click(),
    clickRange: r => chips.find(c => c.dataset.range === r).handlers.click(),
    activeChip: () => chips.find(c => c.classList.contains("active"))?.dataset.range,
    yearHidden: () => byId("year-select").hidden,
    rangeHidden: () => byId("range-group").hidden,
    lastHeaderHidden: () => byId("th-last").hidden,
    projectsTabHidden: () => byId("tab-projects").hidden,
    // the tree rows of the Projects table (everything after the Total row): label, depth, marker, cost, last activity
    tree: () => tbody.children.slice(1).map(r => {
      const first = r.innerHTML.match(/<td[^>]*style="padding-left:(\d+)px"[^>]*>(?:<span class="twisty">([^<]*)<\/span>)?([^<]*)<\/td>/);
      const nums = [...r.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)].map(m => m[1]);   // cost, input, output, cache write, cache read
      const plain = [...r.innerHTML.matchAll(/<td(?: class="nowrap")?>([^<]*)<\/td>/g)].map(m => m[1]);              // models, last activity
      return { label: first[3], depth: (Number(first[1]) - 10) / 18, mark: first[2] ?? "", cost: nums[0], models: plain[0], last: plain[1], row: r };
    }),
    clickRow: label => tbody.children.find(r => r.innerHTML.includes(`</span>${label}</td>`)).handlers.click(),
    selectYear: y => { const sel = byId("year-select"); sel.value = String(y); sel.handlers.change(); },
    yearOptions: () => [...byId("year-select").innerHTML.matchAll(/<option value="(\d{4})"( selected)?>/g)].map(m => ({ year: m[1], selected: Boolean(m[2]) })),
    yearDisabled: () => byId("year-select").disabled,
    // plain copies: objects created inside the vm context have another Array prototype, which strict deepEqual rejects
    header: () => byId("th-first").textContent,
    timeHeaderHidden: () => byId("th-time").hidden,
    // text of the Time cell of every row (Total first): the 6th numeric cell
    timeCells: () => tbody.children.map(r => [...r.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)].map(m => m[1])[5]),
    rateHeaderHidden: () => byId("th-rate").hidden,
    // text of the Rate cell of every row (Total first): the 7th numeric cell
    rateCells: () => tbody.children.map(r => [...r.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)].map(m => m[1])[6]),
    subText: () => byId("sub").textContent,
    clickPrivacy: () => byId("privacy-toggle").handlers.click(),
    privacyButton: () => { const b = byId("privacy-toggle"); return { hidden: b.hidden, on: b.classList.contains("on"), pressed: b.getAttribute("aria-pressed"), title: b.title, label: b.getAttribute("aria-label"), eye: byId("icon-eye").style.display, eyeOff: byId("icon-eye-off").style.display }; },
    // everything a viewer could read that mentions a project: table html, chart labels, tooltip titles, cards
    visibleText: () => JSON.stringify([tbody.children.map(r => r.innerHTML), charts.bar.data.labels, charts.bar.options.plugins.tooltip.callbacks.title(charts.bar.data.labels.map((label, dataIndex) => ({ dataIndex, label }))), ...["min", "avg", "max"].map(k => text("kpi-" + k + "-label"))]),
    barTitle: () => byId("bar-title").textContent,
    cellTitles: () => tbody.children.map(r => r.innerHTML.match(/<td( title="([^"]*)")?>/)?.[2] ?? null),
    barConfig: () => charts.bar, // the raw config, with its callbacks
    bar: () => JSON.parse(JSON.stringify(charts.bar)),
    doughnut: () => JSON.parse(JSON.stringify(charts.doughnut)),
    dates: () => tbody.children.slice(1).map(r => r.innerHTML.match(/<td>([^<]*)<\/td>/)[1]),
    totalCost: () => tbody.children[0].innerHTML.match(/<td class="num"[^>]*>([^<]*)<\/td>/)[1],
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
  const cols = [...total.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)].map(m => m[1]);
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

// ---- the year drop-down ------------------------------------------------------------------------------
const TWO_YEARS = [D("2025-03-10", 10), D("2025-11-20", 20), D("2025-12-30", 5), D("2026-01-02", 7), D("2026-02-14", 30), D("2026-10-01", 4)];

test("year drop-down lists every year of the data, newest first, with the current year selected", () => {
  const p = openPage(TWO_YEARS);
  assert.deepEqual(p.yearOptions(), [{ year: "2026", selected: true }, { year: "2025", selected: false }]);
  assert.equal(p.yearDisabled(), true, "disabled on the Today tab");
  const onlyOld = openPage([D("2024-05-05", 1)]);
  assert.deepEqual(onlyOld.yearOptions(), [{ year: "2024", selected: true }], "no current-year data → the newest year available is selected");
});

test("Daily tab: choosing a year shows exactly that year in the table, the charts, the cards and the Total row", () => {
  const p = openPage(TWO_YEARS);
  p.clickTab("daily");
  assert.equal(p.yearDisabled(), false);
  assert.deepEqual(p.dates(), ["2026-10-01", "2026-02-14", "2026-01-02"]);
  assert.equal(p.totalCost(), "$41.00");
  assert.deepEqual(p.bar().data.labels, ["2026-01-02", "2026-02-14", "2026-10-01"]);
  assert.equal(p.doughnut().data.datasets[0].data.reduce((a, b) => a + b, 0), 41);
  assert.deepEqual(p.cards().max, ["Max cost / day · 2026-02-14", "$30.00"]);

  p.selectYear(2025);
  assert.deepEqual(p.dates(), ["2025-12-30", "2025-11-20", "2025-03-10"]);
  assert.equal(p.totalCost(), "$35.00");
  assert.deepEqual(p.bar().data.labels, ["2025-03-10", "2025-11-20", "2025-12-30"]);
  assert.equal(p.doughnut().data.datasets[0].data.reduce((a, b) => a + b, 0), 35);
  assert.deepEqual(p.cards().min, ["Min cost / day · 2025-12-30", "$5.00"]);
  assert.deepEqual(p.cards().max, ["Max cost / day · 2025-11-20", "$20.00"]);
  assert.equal(p.cards().avg[0], "Avg cost / day · 3 days");

  p.selectYear(2026);
  assert.equal(p.totalCost(), "$41.00", "and back again");
});

test("the chosen year sticks when you switch tabs; Monthly and Weekly follow it", () => {
  const p = openPage(TWO_YEARS);
  p.clickTab("daily");
  p.selectYear(2025);
  p.clickTab("monthly");
  assert.deepEqual(p.dates(), ["2025-12", "2025-11", "2025-03"]);
  assert.equal(p.totalCost(), "$35.00");
  p.selectYear(2026);
  assert.deepEqual(p.dates(), ["2026-10", "2026-02", "2026-01"]);
  assert.equal(p.totalCost(), "$41.00");
  p.clickTab("weekly");
  assert.ok(p.dates().every(d => d.startsWith("2026-")));
});

test("the Today tab ignores the year (the drop-down is disabled there)", () => {
  const p = openPage(TWO_YEARS);
  p.clickTab("daily");
  p.selectYear(2025);
  p.clickTab("today");
  assert.equal(p.yearDisabled(), true);
  assert.deepEqual(p.cards().max, ["Max cost / day · 2026-10-01", "$4.00"], "still the last 30 days of 2026, not the selected 2025");
});

test("a week crossing New Year: every year's Weekly total equals its Daily total, and no phantom year appears", () => {
  const p = openPage(TWO_YEARS); // 2025-12-30 ($5) and 2026-01-02 ($7) share the Monday week of 2025-12-29
  const totals = {};
  for (const year of [2025, 2026]) {
    p.clickTab("daily");   p.selectYear(year); const daily = p.totalCost();
    p.clickTab("weekly");  p.selectYear(year); const weekly = p.totalCost();
    p.clickTab("monthly"); p.selectYear(year); const monthly = p.totalCost();
    totals[year] = [daily, weekly, monthly];
  }
  assert.deepEqual(totals, { 2025: ["$35.00", "$35.00", "$35.00"], 2026: ["$41.00", "$41.00", "$41.00"] });
  p.clickTab("weekly");
  p.selectYear(2025);
  assert.ok(p.dates().includes("2025-12-29"));
  p.selectYear(2026);
  assert.ok(p.dates().includes("2026-01-01"), "the January part of the split week is listed under 2026");
});

test("data that starts just after New Year does not create a year with nothing in it", () => {
  const p = openPage([D("2026-01-02", 7), D("2026-10-01", 4)]); // Monday-start week of 2025-12-29 holds Jan 2
  assert.deepEqual(p.yearOptions(), [{ year: "2026", selected: true }]);
  p.clickTab("weekly");
  assert.equal(p.totalCost(), "$11.00");
  assert.ok(p.dates().includes("2026-01-01"));
});

// ---- Today tab: breakdown by project ------------------------------------------------------------------
const P = (date, project, model, cost, input = 100, output = 200, cacheCreation = 300, cacheRead = 400) => ({ date, project, model, cost, input, output, cacheCreation, cacheRead });
const TODAY = "2026-10-08";
const PROJECTS = [
  P(TODAY, "~/ok/code_p/app", "claude-opus-5", 10), P(TODAY, "~/ok/code_p/app", "claude-sonnet-5", 20), // cheaper model listed FIRST on purpose
  P(TODAY, "~/ok/code/terraform-config", "claude-sonnet-5", 13.5),
  P(TODAY, "~/ok/code/web/app", "claude-haiku-4-5", 1),         // same folder name "app" as the first one
  P(TODAY, "", "claude-sonnet-5", 0.5),
  P("2026-10-07", "~/ok/yesterday-only", "claude-sonnet-5", 99), // not today → must not appear
];
const withToday = () => openPage([D(TODAY, 45), D("2026-10-07", 99)], { projects: PROJECTS });

test("Today tab: the table has one row per project of today, most expensive first, under a Total row", () => {
  const p = withToday();
  p.show("today");
  assert.equal(p.header(), "Project");
  const [total, ...rest] = p.rows();
  assert.equal(total.className, "total");
  assert.deepEqual(rest.map(r => r.innerHTML.match(/<td[^>]*>([^<]*)<\/td>/)[1]), ["code_p/app", "code/terraform-config", "web/app", "(unattributed)"]);
  assert.deepEqual(rest.map(r => [...r.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)][0][1]), ["$30.00", "$13.50", "$1.00", "$0.50"]);
  const cols = [...total.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(cols, ["$45.00", "500", "1k", "1.5k", "2k"], "today's five project×model rows × (100, 200, 300, 400); yesterday is excluded");
  assert.ok(!p.rows().some(r => r.innerHTML.includes("yesterday-only")), "yesterday's project is not shown");
});

test("Today tab: a project's Models cell lists its models, the most expensive first; projects with the same folder name get a longer label", () => {
  const p = withToday();
  p.show("today");
  const models = Object.fromEntries(p.rows().slice(1).map(r => { const tds = [...r.innerHTML.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1]); return [tds[0], tds.at(-1)]; }));
  assert.equal(models["code_p/app"], "sonnet-5, opus-5");
  assert.equal(models["web/app"], "haiku-4-5");
  assert.equal(models["code/terraform-config"], "sonnet-5");
  assert.deepEqual(p.cellTitles().slice(1), ["~/ok/code_p/app", "~/ok/code/terraform-config", "~/ok/code/web/app", "unattributed"], "the full path is on the cell's tooltip");
});

test("Today tab: the bar chart has one stack per project, split by model; the doughnut is today's cost by model", () => {
  const p = withToday();
  p.show("today");
  assert.equal(p.barTitle(), "Cost per project today (by model)");
  const bar = p.bar();
  assert.deepEqual(bar.data.labels, ["Total", "code_p/app", "code/terraform-config", "web/app", "(unattributed)"], "the Total of all projects is the first bar");
  const byModel = Object.fromEntries(bar.data.datasets.map(d => [d.label, d.data]));
  assert.deepEqual(byModel["sonnet-5"], [34, 20, 13.5, 0, 0.5], "Total = the sum of the projects, per model");
  assert.deepEqual(byModel["opus-5"], [10, 10, 0, 0, 0]);
  assert.deepEqual(byModel["haiku-4-5"], [1, 0, 0, 1, 0]);
  const d = p.doughnut().data;
  assert.deepEqual(Object.fromEntries(d.labels.map((l, i) => [l, d.datasets[0].data[i]])), { "sonnet-5": 34, "opus-5": 10, "haiku-4-5": 1 });
});

test("Today tab: Min / Avg / Max stay the last-30-days daily statistics", () => {
  const p = withToday();
  p.show("today");
  assert.deepEqual(p.cards().max, ["Max cost / day · 2026-10-07", "$99.00"]);
  assert.equal(p.cards().avg[0], "Avg cost / day · 2 of last 30 days");
});

test("Today tab with no usage today: a clear message instead of an empty table; other tabs switch the layout back", () => {
  const p = openPage([D("2026-10-07", 99)], { projects: PROJECTS.filter(r => r.date !== TODAY) });
  p.show("today");
  assert.equal(p.header(), "Project");
  assert.equal(p.rows().length, 1);
  assert.match(p.rows()[0].innerHTML, /No usage recorded today yet\./);
  p.clickTab("daily");
  assert.equal(p.header(), "Period");
  assert.equal(p.barTitle(), "Cost per day (by model)");
  assert.equal(p.rows()[0].className, "total");
  p.clickTab("today");
  assert.equal(p.header(), "Project");
});

test("without project data (ccusage source or projects: off) Today keeps the period layout", () => {
  const p = openPage([D(TODAY, 45)]);
  p.show("today");
  assert.equal(p.header(), "Period");
  assert.equal(p.barTitle(), "Cost per today (by model)");
  assert.equal(p.rows().length, 2, "Total + today's day, as before");
});

test("project paths are escaped wherever they are printed", () => {
  const evil = '~/ok/<img src=x onerror=1>"';
  const p = openPage([D(TODAY, 1)], { projects: [P(TODAY, evil, "claude-sonnet-5", 1)] });
  p.show("today");
  const html = p.rows().map(r => r.innerHTML).join("");
  assert.ok(!html.includes("<img"), "no raw tag");
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes('title="~/ok/<'), "the tooltip attribute is escaped too");
});

test("project labels: two path parts by default, longer only when two projects would otherwise look alike", () => {
  const same = openPage([D(TODAY, 3)], { projects: [P(TODAY, "~/a/x/app", "claude-sonnet-5", 2), P(TODAY, "~/b/x/app", "claude-sonnet-5", 1)] });
  same.show("today");
  assert.deepEqual(same.bar().data.labels, ["Total", "a/x/app", "b/x/app"], "x/app is ambiguous → three parts");
  const plain = openPage([D(TODAY, 3)], { projects: [P(TODAY, "~", "claude-sonnet-5", 2), P(TODAY, "~/.claude/projects", "claude-sonnet-5", 1), P(TODAY, "/srv/api/", "claude-sonnet-5", 0.5)] });
  plain.show("today");
  assert.deepEqual(plain.bar().data.labels, ["Total", "~", ".claude/projects", "srv/api"], "short paths stay short; the old '…/projects' no longer looks like a mystery folder 'projects'");
  assert.deepEqual(plain.cellTitles().slice(1), ["~", "~/.claude/projects", "/srv/api/"], "full path on the tooltip");
});

test("bar chart axis: labels longer than 20 characters are clipped with an ellipsis; data, tooltip and table keep the full text", () => {
  const long = "~/ok/code_p/ccusage-ui-dashboard_wrap/ccusage-ui-dashboard"; // label "ccusage-ui-dashboard_wrap/ccusage-ui-dashboard"
  const p = openPage([D(TODAY, 4)], { projects: [
    P(TODAY, long, "claude-sonnet-5", 2),
    P(TODAY, "~/a/b123456789012345678", "claude-sonnet-5", 1.5), // label "a/b123456789012345678" = 21 characters
    P(TODAY, "~/a/12345678901234567", "claude-sonnet-5", 1),     // label "a/12345678901234567" = 19 characters
    P(TODAY, "~/c/123456789012345678", "claude-sonnet-5", 0.9),  // label "c/123456789012345678" = 20 characters: the boundary
    P(TODAY, "~/ok/app", "claude-sonnet-5", 0.4),
    P(TODAY, "", "claude-sonnet-5", 0.1),
  ] });
  p.show("today");
  const cfg = p.barConfig();
  const labels = [...cfg.data.labels];
  assert.deepEqual(labels, ["Total", "ccusage-ui-dashboard_wrap/ccusage-ui-dashboard", "a/b123456789012345678", "a/12345678901234567", "c/123456789012345678", "ok/app", "(unattributed)"], "the chart data keeps the full labels");
  const tick = i => cfg.options.scales.x.ticks.callback.call({ getLabelForValue: v => labels[v] }, i);
  assert.equal(tick(0), "Total");
  assert.equal(tick(1), "ccusage-ui-dashboar…");
  assert.equal(tick(1).length, 20);
  assert.equal(tick(2), "a/b12345678901234567…".slice(0, 19) + "…", "21 characters → 19 + …");
  assert.equal(tick(3), "a/12345678901234567", "19 characters are left alone");
  assert.equal(tick(4), "c/123456789012345678", "exactly 20 characters fit and are not clipped");
  assert.equal(tick(5), "ok/app");
  assert.equal(tick(6), "(unattributed)");
  // the tooltip shows the real path, never the clipped text
  const title = items => cfg.options.plugins.tooltip.callbacks.title(items);
  assert.equal(title([{ dataIndex: 0, label: labels[0] }]), "Total (all projects)");
  assert.equal(title([{ dataIndex: 1, label: labels[1] }]), long);
  assert.equal(title([{ dataIndex: 6, label: labels[6] }]), "(unattributed)");
});

test("clipping touches nothing but long axis labels: dates on the other tabs stay whole, tooltips on them show the label", () => {
  const p = openPage(TWO_YEARS);
  p.clickTab("daily");
  const cfg = p.barConfig();
  const labels = [...cfg.data.labels];
  assert.equal(labels[0], "2026-01-02");
  assert.equal(cfg.options.scales.x.ticks.callback.call({ getLabelForValue: v => labels[v] }, 0), "2026-01-02");
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 0, label: "2026-01-02" }]), "2026-01-02");
  const longLabel = "x".repeat(40);
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ dataIndex: 0, label: longLabel }]), longLabel, "tooltips never show clipped text");
});

// ---- Projects tab -------------------------------------------------------------------------------------
const PR = (date, project, cost, model = "claude-sonnet-5") => ({ date, project, model, cost, input: 10, output: 20, cacheCreation: 30, cacheRead: 40 });
const PROJECT_ROWS = [
  PR("2026-10-05", "~/ok/code/terraform-config", 10),
  PR("2026-10-08", "~/ok/code", 4, "claude-opus-5"),
  PR("2026-09-01", "~/ok/code_p/app", 20),
  PR("2026-10-07", "~/ok/code_p/app/test", 2),
  PR("2026-10-08", "~/.claude", 1),
  PR("2026-08-15", "/srv/api", 3),
  PR("2026-08-20", "", 0.5),
  PR("2026-10-08", "~", 0.25),
];
const projectsPage = (rows = PROJECT_ROWS) => { const p = openPage([D(TODAY, 1)], { projects: rows }); p.clickTab("projects"); return p; };
const shape = p => p.tree().map(r => `${"  ".repeat(r.depth)}${r.mark}${r.label} ${r.cost}`);

test("Projects tab: a path tree, ancestors add up their descendants, chains fold, big branches start open", () => {
  const p = projectsPage();
  assert.equal(p.header(), "Project");
  assert.equal(p.lastHeaderHidden(), false);
  assert.deepEqual(shape(p), [
    "▾~/ok $36.00",
    "  ▾code_p/app $22.00",
    "    .. (this folder) $20.00",
    "    test $2.00",
    "  ▾code $14.00",
    "    .. (this folder) $4.00",
    "    terraform-config $10.00",
    "/srv/api $3.00",
    "~/.claude $1.00",
    "(unattributed) $0.50",
    "~ (home folder) $0.25",
  ]);
});

test("Projects tab: the Total row sums every project (incl. unattributed) and shows the latest activity", () => {
  const p = projectsPage();
  const total = p.rows()[0];
  assert.equal(total.className, "total");
  const cells = [...total.innerHTML.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1]);
  assert.deepEqual(cells.slice(0, 6), ["Total", "$40.75", "80", "160", "240", "320"]);
  assert.equal(cells[7], "2026-10-08");
  assert.equal(cells[6], "sonnet-5, opus-5");
  assert.equal(p.tree().find(r => r.label === "code_p/app").last, "2026-10-07", "a folder's last activity covers its subfolders");
  assert.equal(p.tree().find(r => r.label === "/srv/api").last, "2026-08-15");
});

test("Projects tab: clicking a row collapses / expands it; leaves do nothing", () => {
  const p = projectsPage();
  p.clickRow("code_p/app");
  assert.deepEqual(shape(p).slice(0, 4), ["▾~/ok $36.00", "  ▸code_p/app $22.00", "  ▾code $14.00", "    .. (this folder) $4.00"]);
  p.clickRow("~/ok");
  assert.deepEqual(shape(p).slice(0, 2), ["▸~/ok $36.00", "/srv/api $3.00"]);
  p.clickRow("~/ok");
  assert.equal(shape(p)[0], "▾~/ok $36.00");
  assert.equal(shape(p)[1], "  ▸code_p/app $22.00", "the user's earlier choice is remembered");
  assert.equal(p.tree().find(r => r.label === "/srv/api").row.handlers.click, undefined, "a leaf has no toggle");
});

test("Projects tab: period chips filter by days (today included); chains fold again when a folder loses its own usage", () => {
  const p = projectsPage();
  assert.equal(p.activeChip(), "all");
  p.clickRange("30d"); // 2026-09-09 … 2026-10-08
  assert.equal(p.activeChip(), "30d");
  assert.equal(p.barTitle(), "Cost per project, last 30 days (by model)");
  assert.deepEqual(shape(p), [
    "▾~/ok $16.00",
    "  ▾code $14.00",
    "    .. (this folder) $4.00",
    "    terraform-config $10.00",
    "  code_p/app/test $2.00",
    "~/.claude $1.00",
    "~ (home folder) $0.25",
  ]);
  p.clickRange("7d"); // 2026-10-02 … 2026-10-08 — same rows, the 09-01 usage is out anyway
  assert.equal(p.tree().length, 7);
  p.clickRange("1y");
  assert.equal(p.tree().find(r => r.label === "/srv/api").cost, "$3.00", "12 months reaches back to August");
  p.clickRange("all");
  assert.equal(p.barTitle(), "Cost per project, all time (by model)");
});

test("Projects tab: the chips reset what you expanded or collapsed", () => {
  const p = projectsPage();
  p.clickRow("~/ok");
  assert.equal(p.tree()[0].mark, "▸");
  p.clickRange("30d");
  assert.equal(p.tree()[0].mark, "▾", "back to the default for the new period");
});

test("Projects tab: cards = cheapest / average / most expensive project (folders as recorded, unattributed excluded)", () => {
  const p = projectsPage();
  const c = p.cards();
  assert.deepEqual(c.min, ["Min cost / project · ~", "$0.25"]);
  assert.deepEqual(c.max, ["Max cost / project · code_p/app", "$20.00"]);
  assert.equal(c.avg[0], "Avg cost / project · 7 projects");
  assert.equal(c.avg[1], `$${((10 + 4 + 20 + 2 + 1 + 3 + 0.25) / 7).toFixed(2)}`);
  const none = projectsPage([PR("2026-10-08", "", 1)]);
  assert.deepEqual(none.cards().min, ["Min cost / project", "—"]);
});

test("Projects tab: chart = the biggest folders split by model, the rest as one '+N more' bar; doughnut = cost by model", () => {
  const many = Array.from({ length: 14 }, (_, i) => PR("2026-10-08", `~/ok/p${String(i).padStart(2, "0")}`, 100 - i));
  const p = projectsPage(many);
  const bar = p.bar();
  assert.equal(bar.data.labels.length, 13);
  assert.equal(bar.data.labels.at(-1), "+2 more");
  assert.equal(bar.data.datasets[0].data.at(-1), +(88 + 87).toFixed(4), "the last bar is the sum of the two smallest projects");
  const title = items => p.barConfig().options.plugins.tooltip.callbacks.title(items);
  assert.equal(title([{ dataIndex: 0 }]), "~/ok/p00");
  assert.equal(title([{ dataIndex: 12 }]), "2 more projects");
  const d = p.doughnut().data;
  assert.equal(d.datasets[0].data.reduce((a, b) => a + b, 0), many.reduce((s, r) => s + r.cost, 0));
});

test("Projects tab: controls — year drop-down hidden, period chips shown; other tabs get them back", () => {
  const p = projectsPage();
  assert.equal(p.yearHidden(), true);
  assert.equal(p.yearDisabled(), true);
  assert.equal(p.rangeHidden(), false);
  p.clickTab("daily");
  assert.equal(p.yearHidden(), false);
  assert.equal(p.yearDisabled(), false);
  assert.equal(p.rangeHidden(), true);
  assert.equal(p.lastHeaderHidden(), true);
  assert.equal(p.header(), "Period");
  p.clickTab("today");
  assert.equal(p.yearDisabled(), true);
  assert.equal(p.rangeHidden(), true);
});

test("Projects tab: empty period, and no tab at all when the data has no projects", () => {
  const p = projectsPage([PR("2026-01-01", "~/ok/old", 5)]);
  p.clickRange("7d");
  assert.match(p.rows()[0].innerHTML, /No usage in this period\./);
  assert.equal(p.projectsTabHidden() !== true, true);
  const without = openPage([D(TODAY, 1)]);
  assert.equal(without.projectsTabHidden(), true);
});

test("Projects tab: Windows and absolute paths form their own roots; folder names are escaped", () => {
  const p = projectsPage([PR("2026-10-08", "C:\\Users\\me\\app", 3), PR("2026-10-08", "/Volumes/disk/a", 2), PR("2026-10-08", "/Volumes/disk/b", 1), PR("2026-10-08", "~/ok/<img src=x onerror=1>", 0.5)]);
  assert.deepEqual(shape(p).map(s => s.trim()), ["C:/Users/me/app $3.00", "▾/Volumes/disk $3.00", "a $2.00", "b $1.00", "~/ok/&lt;img src=x onerror=1&gt; $0.50"]); // shown escaped (the harness reads the raw HTML)
  const html = p.rows().map(r => r.innerHTML).join("");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("Projects tab: a small branch starts collapsed (below 20% of the spend) and opens on click", () => {
  const p = projectsPage([PR("2026-10-08", "~/ok/big", 100), PR("2026-10-08", "~/tools/a", 3), PR("2026-10-08", "~/tools/b", 2)]);
  assert.deepEqual(shape(p), ["~/ok/big $100.00", "▸~/tools $5.00"], "~/tools has two children but only 4.8% of the spend");
  p.clickRow("~/tools");
  assert.deepEqual(shape(p), ["~/ok/big $100.00", "▾~/tools $5.00", "  a $3.00", "  b $2.00"]);
});

test("Projects tab: 7d means today and the six days before it; tomorrow's (skewed) rows are never included", () => {
  const p = projectsPage([PR("2026-10-08", "~/ok/today", 1), PR("2026-10-02", "~/ok/edge-in", 1), PR("2026-10-01", "~/ok/edge-out", 1), PR("2026-10-09", "~/ok/tomorrow", 9)]);
  p.clickRange("7d");
  assert.deepEqual(p.tree().map(r => r.label).sort(), ["edge-in", "today", "~/ok"], "~/ok and its two children; edge-out (8 days back) and tomorrow are out");
  p.clickRange("all");
  assert.ok(!p.tree().some(r => r.label.includes("tomorrow")), "even in 'all time'");
  assert.ok(p.tree().some(r => r.label === "edge-out"), "all time does include the old rows");
  assert.equal(p.rows()[0].innerHTML.match(/<td>([^<]*)<\/td>/)[1], "Total");
  assert.match(p.rows()[0].innerHTML, /\$3\.00/, "1 + 1 + 1, tomorrow's $9 excluded");
});

test("project labels: only a name that collides with another gets longer; the others stay at two parts", () => {
  const p = openPage([D(TODAY, 3)], { projects: [P(TODAY, "~/a/x/app", "claude-sonnet-5", 5), P(TODAY, "~/b/x/app", "claude-sonnet-5", 4), P(TODAY, "~/ok/code", "claude-sonnet-5", 3), P(TODAY, "~/ok/code_p/solo", "claude-sonnet-5", 2)] });
  p.show("today");
  assert.deepEqual(p.bar().data.labels, ["Total", "a/x/app", "b/x/app", "ok/code", "code_p/solo"]);
});

test("Projects tab: the indentation is padding on the first cell, so a wrapped name stays aligned", () => {
  const p = projectsPage();
  const html = p.tree()[2].row.innerHTML; // a depth-2 row
  assert.match(html, /<td title="[^"]*" style="padding-left:46px">/);
  assert.ok(!html.includes("margin-left"));
});

test("Projects tab: a folder's own usage is the FIRST row under it, even when it is smaller than its subfolders", () => {
  const p = projectsPage([PR("2026-10-08", "~/ok/app", 1), PR("2026-10-08", "~/ok/app/big", 50), PR("2026-10-08", "~/ok/app/mid", 20)]);
  assert.deepEqual(shape(p), ["▾~/ok/app $71.00", "  .. (this folder) $1.00", "  big $50.00", "  mid $20.00"]);
});

test("Projects tab: 1d is the same folder tree for today only", () => {
  const p = projectsPage([
    PR("2026-10-08", "~/ok/code/a", 6), PR("2026-10-08", "~/ok/code", 2), PR("2026-10-08", "~/ok/code/b", 1),
    PR("2026-10-07", "~/ok/yesterday", 50), PR("2026-10-09", "~/ok/tomorrow", 70),
  ]);
  p.clickRange("1d");
  assert.equal(p.activeChip(), "1d");
  assert.equal(p.barTitle(), "Cost per project, today (by model)");
  assert.deepEqual(shape(p), ["▾~/ok/code $9.00", "  .. (this folder) $2.00", "  a $6.00", "  b $1.00"]);
  assert.match(p.rows()[0].innerHTML, /\$9\.00/, "the Total row too");
  assert.deepEqual(p.bar().data.labels, ["code/a", "ok/code", "code/b"]);
  assert.equal(p.cards().avg[0], "Avg cost / project · 3 projects");
  p.clickRange("7d");
  assert.deepEqual(shape(p), ["▾~/ok $59.00", "  yesterday $50.00", "  ▸code $9.00"], "7d includes yesterday (and still not tomorrow); code is below 20% of the spend, so it starts closed");
});

test("Projects tab: 1d with nothing used today says so", () => {
  const p = projectsPage([PR("2026-10-07", "~/ok/old", 5)]);
  p.clickRange("1d");
  assert.match(p.rows()[0].innerHTML, /No usage in this period\./);
  assert.deepEqual(p.cards().min, ["Min cost / project", "—"]);
});

// ---- the Time column ----------------------------------------------------------------------------------------
const H = 3600;
const withTime = (days, projects = []) => ({ idleMinutes: 10, days, projects });

test("Time column: hidden when the data has no time; present in every table when it does", () => {
  const none = openPage([D(TODAY, 1)]);
  none.show("daily");
  assert.equal(none.timeHeaderHidden(), true);
  assert.deepEqual(none.timeCells().filter(x => x !== undefined), []);
  const p = openPage([D(TODAY, 1)], { time: withTime([[TODAY, 600]]) });
  for (const view of ["daily", "weekly", "monthly", "today"]) {
    p.show(view);
    assert.equal(p.timeHeaderHidden(), false, view);
    assert.ok(p.timeCells().every(c => c !== undefined), `${view}: every row has a Time cell`);
  }
});

test("Time column: durations read 45m · 3h 12m · 5d 3h, rounded to the minute, <1m for a few seconds", () => {
  const cases = [[0, "0m"], [20, "&lt;1m"], [30, "1m"], [45 * 60, "45m"], [59 * 60 + 40, "1h"], [H, "1h"], [3 * H + 12 * 60, "3h 12m"], [24 * H, "1d"], [25 * H, "1d 1h"], [5 * 24 * H + 3 * H, "5d 3h"], [5 * 24 * H + 30 * 60, "5d 1h"]];
  const rows = cases.map(([, ], i) => D(`2026-09-${String(i + 1).padStart(2, "0")}`, 1));
  const p = openPage(rows, { time: withTime(cases.map(([sec], i) => [`2026-09-${String(i + 1).padStart(2, "0")}`, sec])) });
  p.show("daily");
  const shown = p.timeCells().slice(1).reverse(); // newest first → oldest first
  assert.deepEqual(shown, cases.map(([, text]) => text), "(the < of <1m is HTML-escaped in the cell)");
});

test("Time column: a day without measured time shows —, the Total adds the measured days and says ≥ when some are missing", () => {
  const p = openPage([D("2026-10-06", 1), D("2026-10-07", 1), D("2026-10-08", 1)], { time: withTime([["2026-10-06", H], ["2026-10-08", 30 * 60]]) });
  p.show("daily");
  assert.deepEqual(p.timeCells(), ["≥ 1h 30m", "30m", "—", "1h"]);
  const all = openPage([D("2026-10-07", 1), D("2026-10-08", 1)], { time: withTime([["2026-10-07", H], ["2026-10-08", H]]) });
  all.show("daily");
  assert.equal(all.timeCells()[0], "2h", "no ≥ when every day was measured");
  const nothing = openPage([D("2026-10-08", 1)], { time: withTime([]) });
  nothing.show("daily");
  assert.deepEqual(nothing.timeCells(), ["—", "—"]);
});

test("Time column: weekly and monthly rows add up their days; ≥ marks a period with unmeasured days", () => {
  const rows = [D("2026-10-05", 1), D("2026-10-06", 1), D("2026-10-07", 1), D("2026-09-30", 1)];
  const p = openPage(rows, { time: withTime([["2026-10-05", H], ["2026-10-06", H], ["2026-09-30", 600]]) }); // 10-07 not measured
  p.show("weekly");
  // Sunday-or-Monday week starts aside, the three October days share one week row and 09-30 sits in an earlier one
  assert.ok(p.timeCells().slice(1).includes("≥ 2h"), "the week with an unmeasured day: 1h + 1h, marked ≥");
  assert.ok(p.timeCells().slice(1).includes("10m"));
  p.show("monthly");
  assert.deepEqual(p.timeCells().slice(1), ["≥ 2h", "10m"], "October (2h, one day unmeasured) above September (10m, complete)");
  assert.equal(p.timeCells()[0], "≥ 2h 10m");
});

test("Time column on Today: per project, with — for a project that has no measured time, and the real total", () => {
  const projects = [P(TODAY, "~/ok/a", "claude-sonnet-5", 5), P(TODAY, "~/ok/b", "claude-sonnet-5", 3), P(TODAY, "~/ok/c", "claude-sonnet-5", 1)];
  const time = withTime([[TODAY, 5400]], [[TODAY, "~/ok/a", 3600], [TODAY, "~/ok/b", 3600], ["2026-10-07", "~/ok/c", 99]]);
  const p = openPage([D(TODAY, 9)], { projects, time });
  p.show("today");
  // a and b overlapped: 1h each, but only 1h30m of real time in total; c has time only on another day
  assert.deepEqual(p.timeCells(), ["1h 30m", "1h", "1h", "—"]);
});

test("Time column on Projects: folders add up their children, the Total is the real time of the period, ≥ when days are unmeasured", () => {
  const rows = [PR("2026-10-07", "~/ok/code/a", 5), PR("2026-10-08", "~/ok/code/b", 3), PR("2026-10-08", "~/ok/code", 1)];
  const time = withTime([["2026-10-07", 2 * H], ["2026-10-08", H]], [["2026-10-07", "~/ok/code/a", 2 * H], ["2026-10-08", "~/ok/code/b", 40 * 60], ["2026-10-08", "~/ok/code", 20 * 60]]);
  const p = openPage([D("2026-10-07", 5), D(TODAY, 4)], { projects: rows, time });
  p.clickTab("projects");
  assert.equal(p.timeCells()[0], "3h", "Total = the two days' real time, 2h + 1h");
  const cells = p.timeCells();
  const t = Object.fromEntries(p.tree().map((r, i) => [r.label, cells[1 + i]]));
  assert.equal(t["~/ok/code"], "3h", "2h + 40m + 20m: the folder adds up what is below it");
  assert.equal(t["a"], "2h");
  assert.equal(t[".. (this folder)"], "20m");
  p.clickRange("1d");
  assert.equal(p.timeCells()[0], "1h", "today only");
  const gap = openPage([D("2026-10-07", 5), D("2026-10-08", 4)], { projects: rows, time: withTime([["2026-10-08", H]], [["2026-10-08", "~/ok/code/b", H]]) });
  gap.clickTab("projects");
  assert.equal(gap.timeCells()[0], "≥ 1h", "10-07 has usage but no measured time");
});

test("Time column: the empty-table messages span all the columns", () => {
  const p = openPage([D(TODAY, 1)], { projects: [], time: withTime([]) });
  p.show("today");
  assert.match(p.rows()[0].innerHTML, /colspan="9"/);
  p.clickTab("projects");
  assert.match(p.rows()[0].innerHTML, /colspan="10"/);
  const noTime = openPage([D(TODAY, 1)], { projects: [] });
  noTime.show("today");
  assert.match(noTime.rows()[0].innerHTML, /colspan="7"/);
});

// ---- the Rate column (Cost ÷ Time) --------------------------------------------------------------------------
test("Rate column: hidden when the data has no time; present in every table when it does", () => {
  const none = openPage([D(TODAY, 1)]);
  none.show("daily");
  assert.equal(none.rateHeaderHidden(), true);
  assert.deepEqual(none.rateCells().filter(x => x !== undefined), []);
  const p = openPage([D(TODAY, 1)], { time: withTime([[TODAY, 600]]) });
  for (const view of ["daily", "weekly", "monthly", "today"]) {
    p.show(view);
    assert.equal(p.rateHeaderHidden(), false, view);
    assert.ok(p.rateCells().every(c => c !== undefined), `${view}: every row has a Rate cell`);
  }
});

test("Rate column: cost per hour of active work; — when there is no time to divide by", () => {
  const rows = [D("2026-10-05", 6), D("2026-10-06", 5), D("2026-10-07", 3), D("2026-10-08", 9)];
  const p = openPage(rows, { time: withTime([["2026-10-05", H], ["2026-10-06", 0], ["2026-10-08", 30 * 60]]) }); // 10-07 not measured, 10-06 measured as 0
  p.show("daily");
  assert.deepEqual(p.rateCells().slice(1), ["$18.00/h", "—", "—", "$6.00/h"], "newest first: $9 / 0.5h, unmeasured, zero seconds, $6 / 1h");
});

test("Rate column: under a minute of time is too little to divide by — shows —, from a minute on it shows the rate", () => {
  const p = openPage([D("2026-10-06", 0.16), D("2026-10-07", 0.16), D("2026-10-08", 0.16)], { time: withTime([["2026-10-06", 5], ["2026-10-07", 59], ["2026-10-08", 60]]) });
  p.show("daily");
  assert.deepEqual(p.rateCells().slice(1), ["$9.60/h", "—", "—"], "newest first: 60 s → $0.16 per minute; 59 s and 5 s → —");
});

test("Rate column: the Total divides only the cost of the measured days by the real time, ~ marks a partly measured period", () => {
  const p = openPage([D("2026-10-06", 6), D("2026-10-07", 3), D("2026-10-08", 9)], { time: withTime([["2026-10-06", H], ["2026-10-08", 30 * 60]]) });
  p.show("daily");
  // $15 spent on the two measured days in 1h30m = $10/h; dividing all $18 would give $12/h
  assert.equal(p.rateCells()[0], "~ $10.00/h");
  const all = openPage([D("2026-10-07", 4), D("2026-10-08", 8)], { time: withTime([["2026-10-07", H], ["2026-10-08", H]]) });
  all.show("daily");
  assert.equal(all.rateCells()[0], "$6.00/h", "no ~ when every day was measured: $12 / 2h");
});

test("Rate column: weekly and monthly rows leave the cost of unmeasured days out", () => {
  const rows = [D("2026-10-05", 10), D("2026-10-06", 20), D("2026-10-07", 100), D("2026-09-30", 3)];
  const p = openPage(rows, { time: withTime([["2026-10-05", H], ["2026-10-06", H], ["2026-09-30", 1800]]) }); // 10-07 ($100) not measured
  p.show("monthly");
  assert.deepEqual(p.rateCells().slice(1), ["~ $15.00/h", "$6.00/h"], "October: $30 over 2h, not $130; September: $3 / 0.5h");
  p.show("weekly");
  assert.ok(p.rateCells().slice(1).includes("~ $15.00/h"));
  assert.equal(p.rateCells()[0], "~ $13.20/h", "$33 over 2h30m");
});

test("Rate column on Today: per project, — for a project without measured time, the Total uses the united time", () => {
  const projects = [P(TODAY, "~/ok/a", "claude-sonnet-5", 5), P(TODAY, "~/ok/b", "claude-sonnet-5", 3), P(TODAY, "~/ok/c", "claude-sonnet-5", 1)];
  const time = withTime([[TODAY, 5400]], [[TODAY, "~/ok/a", 3600], [TODAY, "~/ok/b", 3600], ["2026-10-07", "~/ok/c", 99]]);
  const p = openPage([D(TODAY, 9)], { projects, time });
  p.show("today");
  // a and b overlapped (1h each, 1h30m together): the Total is $9 / 1.5h, not $9 / 2h
  assert.deepEqual(p.rateCells(), ["$6.00/h", "$5.00/h", "$3.00/h", "—"]);
});

test("Rate column on Projects: folders divide their summed cost by their summed time, the Total by the real time", () => {
  const rows = [PR("2026-10-07", "~/ok/code/a", 5), PR("2026-10-08", "~/ok/code/b", 3), PR("2026-10-08", "~/ok/code", 1)];
  const time = withTime([["2026-10-07", 2 * H], ["2026-10-08", H]], [["2026-10-07", "~/ok/code/a", 2 * H], ["2026-10-08", "~/ok/code/b", 40 * 60], ["2026-10-08", "~/ok/code", 20 * 60]]);
  const p = openPage([D("2026-10-07", 5), D(TODAY, 4)], { projects: rows, time });
  p.clickTab("projects");
  assert.equal(p.rateHeaderHidden(), false);
  assert.equal(p.rateCells()[0], "$3.00/h", "Total: $9 over 3h");
  const cells = p.rateCells();
  const t = Object.fromEntries(p.tree().map((r, i) => [r.label, cells[1 + i]]));
  assert.equal(t["~/ok/code"], "$3.00/h", "$9 over 2h + 40m + 20m");
  assert.equal(t["a"], "$2.50/h");
  assert.equal(t["b"], "$4.50/h", "$3 over 40m");
  assert.equal(t[".. (this folder)"], "$3.00/h", "$1 over 20m");
  p.clickRange("1d");
  assert.equal(p.rateCells()[0], "$4.00/h", "today only: $4 over 1h");
  // 10-07 has usage but no measured time: its $5 stays out of the numerator
  const gap = openPage([D("2026-10-07", 5), D("2026-10-08", 4)], { projects: rows, time: withTime([["2026-10-08", H]], [["2026-10-08", "~/ok/code/b", H]]) });
  gap.clickTab("projects");
  assert.equal(gap.rateCells()[0], "~ $4.00/h", "$4 over 1h, not $9");
  const gapCells = gap.rateCells();
  const g = Object.fromEntries(gap.tree().map((r, i) => [r.label, gapCells[1 + i]]));
  assert.equal(g["a"], "—", "a has no measured time");
  assert.equal(g["b"], "$3.00/h");
  assert.equal(g["~/ok/code"], "$3.00/h", "only b's measured $3 counts, not a's $5 or the folder's own $1 (no time for it)");
  // a project with time on one day and spend on an unmeasured one: only the measured day's spend is divided
  const mixed = openPage([D("2026-10-07", 6), D("2026-10-08", 3)], { projects: [PR("2026-10-07", "~/ok/code/b", 6), PR("2026-10-08", "~/ok/code/b", 3)], time: withTime([["2026-10-08", H]], [["2026-10-08", "~/ok/code/b", H]]) });
  mixed.clickTab("projects");
  assert.equal(mixed.tree()[0].label, "~/ok/code/b");
  assert.equal(mixed.rateCells()[1], "$3.00/h", "$3 of the measured day over 1h, not $9");
});

// ---- compact token counts and rows that stay on one line --------------------------------------------------
test("Token columns: 842 · 1k · 1.4B style, the exact number in the tooltip, rounding never shows 1000k", () => {
  const sizes = [0, 842, 999, 1000, 1049, 1050, 12345, 99949, 99950, 190245, 999499, 999500, 4315998, 1418630336, 2.5e12];
  const projects = sizes.map((n, i) => P(TODAY, `~/ok/p${i}`, "claude-sonnet-5", 1, n, n, n, n));
  const p = openPage([D(TODAY, sizes.length)], { projects });
  p.show("today");
  const cell = i => { const r = p.rows().find(x => x.innerHTML.includes(`>ok/p${i}</td>`) || x.innerHTML.includes(`>p${i}</td>`)); return [...r.innerHTML.matchAll(/<td class="num"([^>]*)>([^<]*)<\/td>/g)].slice(1, 5).map(m => [m[2], m[1]]); };
  const want = ["0", "842", "999", "1k", "1k", "1.1k", "12.3k", "99.9k", "100k", "190k", "999k", "1M", "4.3M", "1.4B", "2.5T"];
  assert.deepEqual(sizes.map((_, i) => cell(i)[0][0]), want);
  assert.deepEqual(cell(13)[0], ["1.4B", ' title="1,418,630,336"'], "hover shows the exact count");
  for (let c = 0; c < 4; c++) assert.equal(cell(13)[c][0], "1.4B", "all four token columns use it");
});

test("Token columns: the Total row is compact too, and so is a period table", () => {
  const p = openPage([{ ...D("2026-10-08", 5), inputTokens: 1234567, outputTokens: 2, cacheCreationTokens: 3000, cacheReadTokens: 78907412 }]);
  p.show("daily");
  for (const row of p.rows()) assert.deepEqual([...row.innerHTML.matchAll(/<td class="num"[^>]*>([^<]*)<\/td>/g)].map(m => m[1]).slice(1), ["1.2M", "2", "3k", "78.9M"]);
});

test("Time, Rate and Last activity never wrap: nowrap on the numeric cells, the date cell and its header", () => {
  assert.match(TEMPLATE, /td\.num, th\.num \{[^}]*white-space: nowrap/);
  assert.match(TEMPLATE, /td\.nowrap, #th-last \{ white-space: nowrap; \}/);
  const p = openPage([D("2026-10-07", 5)], { projects: [PR("2026-10-07", "~/ok/app", 5)] });
  p.clickTab("projects");
  for (const row of p.rows()) assert.match(row.innerHTML, /<td class="nowrap">2026-10-07<\/td>/);
});

// ---- the red average line on the bar chart ----------------------------------------------------------------------
const avgOf = p => p.barConfig().options.plugins.avgLine.value;
const AVG_ROWS = [D("2026-10-06", 2), D("2026-10-07", 4), D("2026-10-08", 6)];

test("Average line: Daily, Weekly and Monthly draw it at the value of the Avg card", () => {
  const p = openPage(AVG_ROWS);
  for (const view of ["daily", "weekly", "monthly"]) {
    p.show(view);
    const card = Number(p.cards().avg[1].slice(1));
    assert.equal(avgOf(p), view === "daily" ? 4 : 12, view); // 4 per day; the three days are one week and one month of 12 each
    assert.equal(avgOf(p).toFixed(2), card.toFixed(2), `${view}: the line equals the card`);
    assert.deepEqual([...p.barConfig().plugins.map(x => x.id)], ["avgLine"]);
  }
});

test("Average line: Today draws it at the Avg card's value, whether the bars are days or projects", () => {
  const plain = openPage([...AVG_ROWS]);
  plain.show("today");
  assert.equal(avgOf(plain), 4, "no project data: the Today bars are days");
  assert.equal(plain.barConfig().options.plugins.avgLine.label, "Avg");
  // daily average over the last 30 days = (30 + 6) / 2 = 18, although both of today's projects cost far less
  const byProject = openPage([D("2026-10-07", 30), D(TODAY, 6)], { projects: [P(TODAY, "~/ok/a", "claude-sonnet-5", 4), P(TODAY, "~/ok/b", "claude-sonnet-5", 2)] });
  byProject.show("today");
  assert.equal(byProject.cards().avg[1], "$18.00");
  assert.equal(avgOf(byProject), 18, "the same value as the card, not the average per project");
  assert.equal(byProject.barConfig().options.plugins.avgLine.label, "Avg", "the same label as on the other charts");
  assert.ok(byProject.barConfig().options.scales.y.suggestedMax >= 18, "the axis reaches the line even though every bar is lower");
  const noneToday = openPage([D(TODAY, 1)], { projects: [P("2026-10-07", "~/ok/old", "claude-sonnet-5", 1)] });
  noneToday.show("today");
  assert.equal(avgOf(noneToday), 1, "no project used today: the line is still the card's value");
});

test("Average line: the axis is stretched only when there is a line", () => {
  const p = openPage(AVG_ROWS);
  p.show("daily");
  assert.ok(p.barConfig().options.scales.y.suggestedMax >= 4);
  const none = openPage([]);
  none.show("daily");
  assert.equal(none.barConfig().options.scales.y.suggestedMax, undefined);
});

test("Average line: Projects draws it at the average cost per project; nothing to average, no line", () => {
  const p = openPage([D(TODAY, 9)], { projects: [PR(TODAY, "~/ok/a", 6), PR(TODAY, "~/ok/b", 2), PR(TODAY, "", 100)] });
  p.clickTab("projects");
  assert.equal(avgOf(p), 4, "(6 + 2) / 2 named projects; unattributed usage is not a project");
  assert.equal(p.barConfig().options.plugins.avgLine.label, "Avg / project");
  assert.equal(avgOf(p).toFixed(2), p.cards().avg[1].slice(1));
  const empty = openPage([D(TODAY, 1)], { projects: [] });
  empty.clickTab("projects");
  assert.equal(avgOf(empty), null);
  const none = openPage([]);
  none.show("daily");
  assert.equal(avgOf(none), null);
});

test("Average line: the plugin strokes a red horizontal line across the plot area with an 'Avg $x' label", () => {
  const p = openPage(AVG_ROWS);
  p.show("daily");
  const plugin = p.barConfig().plugins[0];
  const calls = [];
  const rec = name => (...a) => calls.push([name, ...a]);
  const ctx = { save: rec("save"), restore: rec("restore"), beginPath: rec("beginPath"), moveTo: rec("moveTo"), lineTo: rec("lineTo"), stroke: rec("stroke"), setLineDash: rec("setLineDash"), fillText: rec("fillText") };
  const chart = { ctx, chartArea: { left: 40, right: 500, top: 10, bottom: 300 }, scales: { y: { getPixelForValue: v => 300 - v * 10 } } };
  plugin.afterDatasetsDraw(chart, {}, { value: 4 });
  assert.deepEqual(calls.filter(c => c[0] === "moveTo" || c[0] === "lineTo"), [["moveTo", 40, 260], ["lineTo", 500, 260]]);
  assert.match(ctx.strokeStyle, /^#e5484d$/i);
  assert.equal(ctx.lineWidth, 1);
  assert.deepEqual(calls.filter(c => c[0] === "setLineDash").map(c => [...c[1]]), [[6, 4], []], "dashed for the line, solid again for the label");
  assert.ok(calls.findIndex(c => c[0] === "setLineDash") < calls.findIndex(c => c[0] === "stroke"), "the dash is set before stroking");
  assert.deepEqual(calls.find(c => c[0] === "fillText"), ["fillText", "Avg $4.00", 496, 257]);
  assert.match(ctx.font, /\b9px\b/, "a small label");
  calls.length = 0;
  plugin.afterDatasetsDraw(chart, {}, { value: 4, label: "Avg / project" });
  assert.equal(calls.find(c => c[0] === "fillText")[1], "Avg / project $4.00");
  assert.ok(calls.some(c => c[0] === "stroke"));
  // nothing drawn without a value, or when the value falls outside the plot area
  for (const opts of [{ value: null }, undefined, { value: 40 }]) {
    const before = calls.length;
    plugin.afterDatasetsDraw(chart, {}, opts);
    assert.equal(calls.length, before, JSON.stringify(opts));
  }
});

test("Today by project: the Total bar is the first one and equals the sum of the projects, so it can be read against the average line", () => {
  const p = openPage([D("2026-10-07", 30), D(TODAY, 6)], { projects: [P(TODAY, "~/ok/a", "claude-sonnet-5", 4), P(TODAY, "~/ok/b", "claude-opus-5", 2)] });
  p.show("today");
  const bar = p.bar();
  assert.deepEqual(bar.data.labels, ["Total", "ok/a", "ok/b"]);
  const stack = i => bar.data.datasets.reduce((s, d) => s + d.data[i], 0);
  assert.deepEqual([stack(0), stack(1), stack(2)], [6, 4, 2]);
  assert.equal(avgOf(p), 18, "the line is the daily average the Total bar is compared with");
  assert.equal(p.rows()[0].className, "total", "the table's Total row is still the first row");
  const empty = openPage([D(TODAY, 1)], { projects: [] });
  empty.show("today");
  assert.deepEqual([...empty.bar().data.labels], [], "no usage today: no Total bar either");
  const days = openPage(AVG_ROWS);
  days.show("today");
  assert.ok(!days.bar().data.labels.includes("Total"), "without project data the bars are days, no Total bar");
});

// ---- the generation time in the sub-line ------------------------------------------------------------------------
test("Generated at: local date and time with the zone offset, not a UTC ISO string", () => {
  const was = process.env.TZ;
  const stamp = tz => { process.env.TZ = tz; return openPage([D(TODAY, 1)], { generatedAt: "2026-10-08T22:28:52.087Z" }).subText().split(" · ")[0]; };
  try {
    assert.equal(stamp("Europe/Kyiv"), "Generated at 2026-10-09 01:28:52 GMT+3", "the day rolls over with the offset");
    assert.equal(stamp("America/Los_Angeles"), "Generated at 2026-10-08 15:28:52 GMT-7");
    assert.equal(stamp("Asia/Kolkata"), "Generated at 2026-10-09 03:58:52 GMT+5:30", "half-hour offsets keep their minutes");
    assert.equal(stamp("UTC"), "Generated at 2026-10-08 22:28:52 GMT");
    assert.doesNotMatch(stamp("Europe/Kyiv"), /\dT\d|\.\d{3}Z/, "no ISO separator, no milliseconds, no Z");
    process.env.TZ = "Europe/Kyiv";
    assert.match(openPage([D(TODAY, 1)], { generatedAt: "garbage" }).subText(), /^Generated at garbage/, "an unreadable stamp is shown as is");
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

// ---- privacy mode (the eye) -------------------------------------------------------------------------------------
const SECRETS = ["ccusage-ui-dashboard_wrap", "terraform-config", "acme", "bob", "solo"];
const privacyRows = () => [
  P(TODAY, "~/ok/code_p/ccusage-ui-dashboard_wrap/ccusage-ui-dashboard", "claude-sonnet-5", 5),
  P(TODAY, "~/ok/code/terraform-config", "claude-sonnet-5", 3),
  P(TODAY, "/srv/acme/solo", "claude-sonnet-5", 2),
  P(TODAY, "C:\\Users\\bob\\app", "claude-sonnet-5", 1.5),
  P(TODAY, "~", "claude-sonnet-5", 1),
  P(TODAY, "", "claude-sonnet-5", 0.5),
];
const leaks = p => SECRETS.filter(w => p.visibleText().includes(w));

test("Privacy: the eye is next to the theme toggle, open by default, and nothing is hidden", () => {
  const p = openPage([D(TODAY, 13)], { projects: privacyRows() });
  p.show("today");
  assert.deepEqual(p.privacyButton(), { hidden: false, on: false, pressed: "false", title: "Hide project names", label: "Hide project names", eye: "", eyeOff: "none" });
  assert.ok(leaks(p).length > 0, "names are visible");
  assert.match(TEMPLATE, /<div class="header-actions">\s*<button id="privacy-toggle"[\s\S]*?<button id="theme-toggle"/, "markup order: eye, then theme toggle, in one group");
});

test("Privacy: Today by project — the closed eye masks every segment in the table, titles, chart and tooltip; Total and (unattributed) stay", () => {
  const p = openPage([D(TODAY, 13)], { projects: privacyRows() });
  p.show("today");
  p.clickPrivacy();
  assert.deepEqual(p.privacyButton(), { hidden: false, on: true, pressed: "true", title: "Show project names", label: "Show project names", eye: "none", eyeOff: "" });
  assert.deepEqual(leaks(p), [], "no project name is left anywhere");
  assert.deepEqual([...p.bar().data.labels], ["Total", "****/****", "****/****", "****/****", "****/****", "~", "(unattributed)"]);
  assert.deepEqual(p.cellTitles().slice(1), ["~/****/****/****/****", "~/****/****/****", "/****/****/****", "C:\\****\\****\\****", "~", "unattributed"], "the hover path is masked per segment; ~ is not a name");
  const html = p.rows()[1].innerHTML;
  assert.match(html, /\$5\.00/, "the numbers are untouched");
  const title = items => p.barConfig().options.plugins.tooltip.callbacks.title(items);
  assert.equal(title([{ dataIndex: 1, label: "x" }]), "~/****/****/****/****");
  assert.equal(title([{ dataIndex: 2, label: "x" }]), "~/****/****/****");
  assert.equal(title([{ dataIndex: 0, label: "Total" }]), "Total (all projects)");
  p.clickPrivacy();
  assert.deepEqual(p.privacyButton().on, false);
  assert.ok(leaks(p).length > 0, "the open eye brings the names back");
  assert.deepEqual([...p.bar().data.labels].slice(0, 2), ["Total", "ccusage-ui-dashboard_wrap/ccusage-ui-dashboard"]);
});

test("Privacy: Projects tab — tree labels, hover paths, cards and bars are masked, the structure and the numbers stay", () => {
  const rows = [PR(TODAY, "~/ok/code/terraform-config", 9), PR(TODAY, "~/ok/code", 4), PR(TODAY, "~/ok/acme/solo", 3), PR(TODAY, "", 1)];
  const p = openPage([D(TODAY, 17)], { projects: rows });
  p.clickTab("projects");
  const plain = p.tree().map(r => [r.label, r.cost, r.depth]);
  p.clickPrivacy();
  assert.deepEqual(leaks(p), []);
  const masked = p.tree().map(r => [r.label, r.cost, r.depth]);
  assert.deepEqual(masked.map(r => r[1]), plain.map(r => r[1]), "same costs");
  assert.deepEqual(masked.map(r => r[2]), plain.map(r => r[2]), "same indentation");
  assert.deepEqual(masked.map(r => r[0]), plain.map(([label]) => (label === ".. (this folder)" || label === "(unattributed)" ? label : label.replace(/[^/]+/g, seg => (seg === "~" ? seg : "****")))));
  assert.ok(masked.some(r => r[0] === ".. (this folder)"), "the structural label stays");
  assert.match(p.cards().min[0], /^Min cost \/ project · \*\*\*\*\/\*\*\*\*$/);
  assert.match(p.cards().max[0], /\*\*\*\*/);
  assert.ok(p.tree().every(r => !/terraform|acme|solo/.test(r.row.innerHTML)), "not even in the title attributes");
  // clicking a row still expands / collapses it while the names are hidden
  const before = p.tree().length;
  const folder = p.tree().find(r => r.mark === "▾" || r.mark === "▸");
  p.clickRow(folder.label);
  assert.notEqual(p.tree().length, before);
  assert.deepEqual(leaks(p), []);
});

test("Privacy: the '+N more' bar keeps its label; the choice survives a tab switch; Daily has no names to hide", () => {
  const many = Array.from({ length: 14 }, (_, i) => PR(TODAY, `~/ok/secret${String(i).padStart(2, "0")}`, 100 - i));
  const p = openPage([D(TODAY, 1000)], { projects: many });
  p.clickTab("projects");
  p.clickPrivacy();
  assert.equal([...p.bar().data.labels].at(-1), "+2 more");
  assert.equal(p.visibleText().includes("secret"), false);
  p.clickTab("today");
  assert.equal(p.visibleText().includes("secret"), false, "still hidden after switching tabs");
  assert.equal(p.privacyButton().on, true);
  p.clickTab("daily");
  assert.equal(p.rows().length > 1, true);
  p.clickTab("projects");
  assert.equal(p.visibleText().includes("secret"), false);
});

test("Privacy: the eye is hidden when the page has no project data, and every page starts with the names shown", () => {
  const none = openPage([D(TODAY, 1)]);
  none.show("today");
  assert.equal(none.privacyButton().hidden, true);
  const fresh = openPage([D(TODAY, 1)], { projects: privacyRows() });
  assert.equal(fresh.privacyButton().on, false, "the choice is not remembered between pages");
});
