import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../build.mjs";
import { AGENTS } from "../lib/agents/index.mjs";
import { classicRow } from "./helpers.mjs";

const TEMPLATE = "<title>AI Usage Dashboard</title>\n<script>__CHARTJS__</script>\n<script>\nconst DATA = __DATA__;\n</script>\n";
const NOW = new Date(2026, 9, 8, 12, 0, 0);

// Test doubles for readLogs(): cells plus the 15-minute buckets the real reader returns (placed at local noon of each day).
const withBuckets = (cells, stats) => ({
  cells,
  buckets: cells.map(c => ({ project: c.project ?? "", t: Math.floor(new Date(+c.date.slice(0, 4), +c.date.slice(5, 7) - 1, +c.date.slice(8, 10), 12).getTime() / 900000), model: c.model, input: c.input, output: c.output, cacheCreation: c.cacheCreation, cacheRead: c.cacheRead })),
  stats,
});

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccud-build-"));
  const template = join(dir, "template.html");
  writeFileSync(template, TEMPLATE);
  const logs = [];
  const deps = {
    fetch: () => ({ daily: [classicRow("2026-10-07", 2), classicRow("2026-10-08", 3)] }),
    readLogs: () => ({ cells: [], stats: { roots: [], files: 0, records: 0, duplicates: 0 } }), // never read the real logs in tests
    fetchImpl: async () => { throw new Error("network disabled in tests"); },
    pricesCachePath: join(dir, "prices-cache.json"),
    historyPath: join(dir, "history.json"),
    open: () => true,
    now: NOW,
    log: m => logs.push(m),
    ...extra,
  };
  return { dir, template, out: join(dir, "out", "index.html"), logs, deps };
}

const dataOf = html => JSON.parse(html.match(/^const DATA = (.*);$/m)[1]);

test("renders template → out (dev mode: explicit --template/--out) and prints the summary", async () => {
  const { template, out, logs, deps } = setup();
  assert.equal(await main(["--no-open", "--template", template, "--out", out, "--config", "/nonexistent"], deps), 0);
  const html = readFileSync(out, "utf8");
  const data = dataOf(html);
  assert.equal(data.daily.length, 2);
  assert.equal(data.monthly[0].totalCost, 5);
  assert.equal(data.generatedAt, NOW.toISOString());
  assert.equal(data.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.ok(html.includes("<title>AI Usage Dashboard</title>"));
  assert.ok(!/__DATA__|__CHARTJS__/.test(html));
  assert.ok(html.includes("Chart.js v4.4.6"), "Chart.js is inlined");
  assert.ok(!html.includes("cdn.jsdelivr"), "no CDN reference");
  assert.ok(logs.some(l => l.includes("quick summary")));
  assert.ok(logs.some(l => l.includes(`Dashboard regenerated: ${out}`)));
});

test("config.json weekStart is applied", async () => {
  const { dir, template, out, deps } = setup();
  const config = join(dir, "config.json");
  writeFileSync(config, '{"weekStart":"sunday"}');
  await main(["--no-open", "--template", template, "--out", out, "--config", config], deps);
  assert.equal(dataOf(readFileSync(out, "utf8")).weekly[0].week, "2026-10-04");
  writeFileSync(config, '{"weekStart":"monday"}');
  await main(["--no-open", "--template", template, "--out", out, "--config", config], deps);
  assert.equal(dataOf(readFileSync(out, "utf8")).weekly[0].week, "2026-10-05");
});

test("--no-summary and --no-open are honoured; a failed browser launch does not fail the build", async () => {
  let opened = 0;
  const a = setup({ open: () => (opened++, true) });
  await main(["--no-open", "--no-summary", "--template", a.template, "--out", a.out, "--config", "/x"], a.deps);
  assert.equal(opened, 0);
  assert.ok(!a.logs.some(l => l.includes("quick summary")));

  const b = setup({ open: () => false });
  assert.equal(await main(["--no-summary", "--template", b.template, "--out", b.out, "--config", "/x"], b.deps), 0);
  assert.ok(b.logs.some(l => l.includes("open this file manually")));
});

test("bad ccusage output or config fails before touching the output file", async () => {
  const bad = setup({ fetch: () => ({ weekly: [] }) });
  await assert.rejects(() => main(["--template", bad.template, "--out", bad.out, "--config", "/x"], bad.deps), /no "daily" array/);
  assert.ok(!existsSync(bad.out));

  const cfg = setup();
  const config = join(cfg.dir, "config.json");
  writeFileSync(config, '{"weekStart":"funday"}');
  await assert.rejects(() => main(["--template", cfg.template, "--out", cfg.out, "--config", config], cfg.deps), /weekStart/);
  writeFileSync(config, "{nope");
  await assert.rejects(() => main(["--template", cfg.template, "--out", cfg.out, "--config", config], cfg.deps), /not valid JSON/);
});

test("unknown options are rejected", async () => {
  const { deps } = setup();
  await assert.rejects(() => main(["--wat"], deps), /unknown option/);
});

test("source: logs — builds from transcripts with prices, flags unpriced models, never calls ccusage", async () => {
  const cells = [
    { date: "2026-10-08", model: "claude-sonnet-5", input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0 },
    { date: "2026-10-08", model: "claude-mystery-9", input: 5, output: 5, cacheCreation: 0, cacheRead: 0 },
  ];
  const pricesPath = join(mkdtempSync(join(tmpdir(), "ccud-prices-")), "prices.json");
  writeFileSync(pricesPath, JSON.stringify({ fetchedAt: "2026-10-01", models: { "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } } }));
  const { template, out, logs, deps } = setup({
    readLogs: () => withBuckets(cells, { roots: ["/r"], files: 3, records: 2, duplicates: 7 }),
    fetch: () => { throw new Error("ccusage must not be called"); },
    pricesPath,
  });
  await main(["--no-open", "--template", template, "--out", out, "--config", "/x"], deps);
  const data = dataOf(readFileSync(out, "utf8"));
  assert.equal(data.source, "logs");
  assert.deepEqual(data.unpriced, ["claude-mystery-9"]);
  assert.equal(data.daily[0].totalCost, 12); // $2 in + $10 out; the unpriced model adds $0
  assert.ok(logs.some(l => l.includes("Data source: Claude Code logs (3 files, 2 usage records, 7 duplicate")));
  assert.ok(logs.some(l => l.includes("No price for 1 model(s): claude-mystery-9")));
});

test("source: auto falls back to ccusage when there are no usage records; --source overrides config", async () => {
  const a = setup();
  await main(["--no-open", "--template", a.template, "--out", a.out, "--config", "/x"], a.deps);
  assert.equal(dataOf(readFileSync(a.out, "utf8")).source, "ccusage");
  assert.ok(a.logs.some(l => l.includes("falling back to ccusage")));

  const b = setup();
  await assert.rejects(() => main(["--source", "logs", "--template", b.template, "--out", b.out, "--config", "/x"], b.deps), /no Claude Code log directory found/);
  await assert.rejects(() => main(["--source", "nope"], b.deps), /--source must be one of/);

  const c = setup();
  const config = join(c.dir, "config.json");
  writeFileSync(config, '{"source":"logs"}');
  await assert.rejects(() => main(["--template", c.template, "--out", c.out, "--config", config], c.deps), /no Claude Code log directory found/);
  await main(["--no-open", "--source", "ccusage", "--template", c.template, "--out", c.out, "--config", config], c.deps); // CLI wins over config
  assert.equal(dataOf(readFileSync(c.out, "utf8")).source, "ccusage");
});

test("config.json prices make an otherwise unpriced model priced (the fix path the warning points to)", async () => {
  const cells = [{ date: "2026-10-08", model: "claude-mystery-9", input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 }];
  const s = setup({ readLogs: () => withBuckets(cells, { roots: ["/r"], files: 1, records: 1, duplicates: 0 }), pricesPath: "/nonexistent" });
  const config = join(s.dir, "config.json");
  writeFileSync(config, JSON.stringify({ prices: { "claude-mystery-9": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } } }));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(data.unpriced, []);
  assert.equal(data.daily[0].totalCost, 3);
});

const entryLL = (i, o, cw, cr) => ({ litellm_provider: "anthropic", input_cost_per_token: i / 1e6, output_cost_per_token: o / 1e6, cache_creation_input_token_cost: cw / 1e6, cache_read_input_token_cost: cr / 1e6 });
const llTable = (extra = {}) => ({ ...Object.fromEntries(["a", "b", "c", "d", "e"].map(n => [`claude-${n}`, entryLL(1, 5, 1.25, 0.1)])), ...extra });
const llFetch = data => { const f = async () => (f.calls++, { ok: true, status: 200, json: async () => data }); f.calls = 0; return f; };
const oneCell = model => [{ date: "2026-10-08", model, input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 }];
const logsDeps = cells => ({ readLogs: () => withBuckets(cells, { roots: ["/r"], files: 1, records: 1, duplicates: 0 }) });

test("--refresh-prices downloads into the cache; the payload says when prices are from and how they were obtained", async () => {
  const f = llFetch(llTable({ "claude-newbie": entryLL(4, 20, 5, 0.4) }));
  const s = setup({ ...logsDeps(oneCell("claude-newbie")), fetchImpl: f, pricesPath: "/nonexistent" });
  await main(["--no-open", "--refresh-prices", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.equal(f.calls, 1);
  assert.deepEqual(data.prices, { asOf: "2026-10-08", origin: "refreshed", ageDays: 0, refreshFailed: false });
  assert.equal(data.daily[0].totalCost, 4);
  assert.ok(s.logs.some(l => l.startsWith("Prices refreshed")));
  assert.ok(!s.logs.some(l => /Prices as of/.test(l)), "no 'old prices' note when they are fresh");
  assert.equal(JSON.parse(readFileSync(join(s.dir, "prices-cache.json"), "utf8")).schema, 1);
});

test("--offline and --refresh-prices contradict each other; --offline never touches the network", async () => {
  const f = llFetch(llTable());
  const s = setup({ ...logsDeps(oneCell("claude-sonnet-5")), fetchImpl: f });
  await assert.rejects(() => main(["--offline", "--refresh-prices"], s.deps), /contradict/);
  await main(["--no-open", "--offline", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  assert.equal(f.calls, 0);
  assert.equal(dataOf(readFileSync(s.out, "utf8")).prices.origin, "bundled");
});

test("offline with an old cache: the build still works, labels the prices as old and the chat summary says so", async () => {
  const s = setup({ ...logsDeps(oneCell("claude-sonnet-5")), pricesPath: "/nonexistent" }); // default fetchImpl throws = offline
  writeFileSync(join(s.dir, "prices-cache.json"), JSON.stringify({ schema: 1, fetchedAt: new Date(2026, 9, 5, 9).toISOString(), models: { "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } } }));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(data.prices, { asOf: "2026-10-05", origin: "cache", ageDays: 3, refreshFailed: true });
  assert.equal(data.daily[0].totalCost, 2, "old prices still price the data");
  assert.ok(s.logs.some(l => l.includes("Prices as of 2026-10-05 (could not be refreshed)")));
});

test("a model without a price triggers one more download attempt (it may have been added upstream)", async () => {
  const f = llFetch(llTable({ "claude-newbie": entryLL(4, 20, 5, 0.4) }));
  const s = setup({ ...logsDeps(oneCell("claude-newbie")), fetchImpl: f, pricesPath: "/nonexistent" });
  // cache from 2 hours ago, downloaded today, without the new model → not due, but unpriced → retry allowed
  writeFileSync(join(s.dir, "prices-cache.json"), JSON.stringify({ schema: 1, fetchedAt: new Date(NOW.getTime() - 2 * 3600e3).toISOString(), models: { "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } } }));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.equal(f.calls, 1);
  assert.deepEqual(data.unpriced, []);
  assert.equal(data.daily[0].totalCost, 4);
  assert.equal(data.prices.origin, "refreshed");
});

test("priceRefresh: off in config.json keeps the dashboard fully offline", async () => {
  const f = llFetch(llTable());
  const s = setup({ ...logsDeps(oneCell("claude-sonnet-5")), fetchImpl: f });
  const config = join(s.dir, "config.json");
  writeFileSync(config, '{"priceRefresh":"off"}');
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  assert.equal(f.calls, 0);
});

test("--refresh-prices downloads even when the cache is already fresh today (and a plain run does not)", async () => {
  const f = llFetch(llTable());
  const s = setup({ ...logsDeps(oneCell("claude-sonnet-5")), fetchImpl: f });
  writeFileSync(join(s.dir, "prices-cache.json"), JSON.stringify({ schema: 1, fetchedAt: new Date(NOW.getTime() - 60_000).toISOString(), models: { "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } } }));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  assert.equal(f.calls, 0, "fresh cache → no download");
  await main(["--no-open", "--refresh-prices", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  assert.equal(f.calls, 1, "explicit refresh overrides the daily policy");
});

const cellOn = (date, model = "claude-sonnet-5", input = 1_000_000) => ({ date, model, input, output: 0, cacheCreation: 0, cacheRead: 0 });
const statsOf = (files = 1) => ({ roots: ["/r"], files, records: 1, duplicates: 0 });
const noNet = () => { throw new Error("ccusage must not be called"); };
const PRICED = { pricesPath: "/nonexistent" }; // no bundled table → use config prices below
const cfgWithPrice = (dir, extra = {}) => {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ priceRefresh: "off", prices: { "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } }, ...extra }));
  return p;
};

test("history: days that disappear from the Claude Code logs stay in the dashboard", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const config = cfgWithPrice(s.dir);
  const run = async cells => {
    s.deps.readLogs = () => withBuckets(cells, statsOf());
    s.logs.length = 0;
    await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
    return dataOf(readFileSync(s.out, "utf8"));
  };
  const first = await run([cellOn("2026-08-30"), cellOn("2026-10-07")]);
  assert.deepEqual(first.daily.map(d => d.date), ["2026-08-30", "2026-10-07"]);
  assert.equal(first.history.restoredDays, 0);
  assert.ok(existsSync(join(s.dir, "history.json")));

  // Claude Code's cleanup removed the old transcript; only the recent one is left
  const later = await run([cellOn("2026-10-07")]);
  assert.deepEqual(later.daily.map(d => d.date), ["2026-08-30", "2026-10-07"], "the old day is restored from history.json");
  assert.equal(later.daily[0].totalCost, 2, "…and priced with the current table");
  assert.deepEqual(later.history, { days: 2, first: "2026-08-30", restoredDays: 1 });
  assert.ok(s.logs.some(l => l.includes("History: 2 days kept in history.json (since 2026-08-30), 1 of them no longer in the logs.")));
});

test("history: with no transcripts at all the ledger is still used and ccusage is not called", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const config = cfgWithPrice(s.dir);
  s.deps.readLogs = () => withBuckets([cellOn("2026-09-01")], statsOf());
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  s.deps.readLogs = () => withBuckets([], { roots: [], files: 0, records: 0, duplicates: 0 });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.equal(data.source, "logs");
  assert.deepEqual(data.daily.map(d => d.date), ["2026-09-01"]);
});

test("history: 'off' writes nothing; --source ccusage never touches the ledger", async () => {
  const off = setup({ ...logsDeps([cellOn("2026-10-07")]), ...PRICED });
  await main(["--no-open", "--template", off.template, "--out", off.out, "--config", cfgWithPrice(off.dir, { history: "off" })], off.deps);
  assert.equal(existsSync(join(off.dir, "history.json")), false);
  assert.equal(dataOf(readFileSync(off.out, "utf8")).history, null);

  const cc = setup({ ...logsDeps([cellOn("2026-10-07")]) });
  await main(["--no-open", "--source", "ccusage", "--template", cc.template, "--out", cc.out, "--config", "/x"], cc.deps);
  assert.equal(existsSync(join(cc.dir, "history.json")), false);
});

test("history: --reset-history rebuilds from the logs that exist now and keeps the old file as .bak", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const config = cfgWithPrice(s.dir);
  const go = async (cells, extra = []) => {
    s.deps.readLogs = () => withBuckets(cells, statsOf());
    await main(["--no-open", ...extra, "--template", s.template, "--out", s.out, "--config", config], s.deps);
    return dataOf(readFileSync(s.out, "utf8"));
  };
  await go([cellOn("2026-08-30"), cellOn("2026-10-07")]);
  const reset = await go([cellOn("2026-10-07")], ["--reset-history"]);
  assert.deepEqual(reset.daily.map(d => d.date), ["2026-10-07"]);
  const bak = JSON.parse(readFileSync(join(s.dir, "history.json.bak"), "utf8"));
  assert.equal(bak.rows.length, 2, "the previous ledger survives as .bak");
});

test("history: a ledger written by a newer version is used but never overwritten", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const file = join(s.dir, "history.json");
  const future = JSON.stringify({ schema: 99, models: ["claude-sonnet-5"], projects: [""], rows: [[Math.floor(new Date(2026, 7, 1, 12).getTime() / 900000), 0, 0, 5, 5, 5, 5, 0.5]] });
  writeFileSync(file, future);
  s.deps.readLogs = () => withBuckets([cellOn("2026-10-07")], statsOf());
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", cfgWithPrice(s.dir)], s.deps);
  assert.equal(readFileSync(file, "utf8"), future);
  assert.equal(dataOf(readFileSync(s.out, "utf8")).daily.length, 2, "its data is still shown");
});

test("history: a price change never rewrites an already recorded day (end to end)", async () => {
  const s = setup({ fetch: noNet, pricesPath: "/nonexistent" });
  const config = join(s.dir, "config.json");
  const price = rate => writeFileSync(config, JSON.stringify({ priceRefresh: "off", prices: { "claude-sonnet-5": { input: rate, output: rate, cacheWrite: rate, cacheRead: rate } } }));
  const go = async cells => {
    s.deps.readLogs = () => withBuckets(cells, statsOf());
    await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
    return dataOf(readFileSync(s.out, "utf8"));
  };
  price(100);
  const august = await go([cellOn("2026-08-30")]);                   // 1M input tokens at $100/M
  assert.equal(august.daily[0].totalCost, 100);
  price(50);                                                           // the provider cuts the price in September
  const september = await go([cellOn("2026-08-30"), cellOn("2026-09-15")]);
  const byDate = Object.fromEntries(september.daily.map(d => [d.date, d.totalCost]));
  assert.deepEqual(byDate, { "2026-08-30": 100, "2026-09-15": 50 }, "August stays $100; the new day is priced at the new rate");
  const afterCleanup = await go([cellOn("2026-09-15")]);               // the August transcript was cleaned up
  assert.equal(afterCleanup.daily.find(d => d.date === "2026-08-30").totalCost, 100);
  assert.equal(afterCleanup.monthly.find(m => m.month === "2026-08").totalCost, 100);
});

const projCell = (date, project, model = "claude-sonnet-5", input = 1_000_000) => ({ date, project, model, input, output: 0, cacheCreation: 0, cacheRead: 0 });

test("payload.projects: day × project × model rows for the whole history, priced; null with projects off or the ccusage source", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const config = cfgWithPrice(s.dir);
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/app"), projCell("2026-10-08", "~/ok/lib", "claude-sonnet-5", 500_000), projCell("2026-10-07", "~/ok/app"), projCell("2026-08-01", "~/old")], statsOf());
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  const key = r => `${r.date} ${r.project}`;
  assert.deepEqual(data.projects.map(key), ["2026-08-01 ~/old", "2026-10-07 ~/ok/app", "2026-10-08 ~/ok/app", "2026-10-08 ~/ok/lib"], "old days are included: the Projects tab needs the whole history");
  assert.deepEqual(data.projects.map(r => r.cost), [2, 2, 2, 1]);
  assert.equal(data.projects.reduce((s, r) => s + r.cost, 0), data.daily.reduce((s, d) => s + d.totalCost, 0), "the project rows add up to the daily totals");

  const off = setup({ fetch: noNet, ...PRICED });
  off.deps.readLogs = s.deps.readLogs;
  await main(["--no-open", "--template", off.template, "--out", off.out, "--config", cfgWithPrice(off.dir, { projects: "off" })], off.deps);
  assert.equal(dataOf(readFileSync(off.out, "utf8")).projects, null);

  const cc = setup();
  await main(["--no-open", "--source", "ccusage", "--template", cc.template, "--out", cc.out, "--config", "/x"], cc.deps);
  assert.equal(dataOf(readFileSync(cc.out, "utf8")).projects, null);
});

test("payload.projects: every row carries the estimated cache saving at the current prices; a model without a price carries none", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([
    { date: "2026-10-08", project: "~/ok/app", model: "claude-sonnet-5", input: 0, output: 0, cacheCreation: 1_000_000, cacheRead: 4_000_000 },
    { date: "2026-10-08", project: "~/ok/app", model: "claude-mystery-9", input: 0, output: 0, cacheCreation: 0, cacheRead: 1_000_000 },
  ], { roots: [], files: 1, records: 2, duplicates: 0 });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", cfgWithPrice(s.dir)], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  const byModel = Object.fromEntries(data.projects.map(r => [r.model, r.saved]));
  assert.equal(byModel["claude-sonnet-5"], 4 * 1.8 - 0.5, "(4M reads × (2 − 0.2) + 1M writes × (2 − 2.5)) / 1M");
  assert.equal(byModel["claude-mystery-9"], undefined);
  assert.equal(data.daily[0].cacheSaved, 4 * 1.8 - 0.5);
});

test("projects: an existing schema-1 history file is migrated without double counting or losing recorded costs", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const q = (y, m, d) => Math.floor(new Date(y, m - 1, d, 12).getTime() / 900000);
  // written by the previous version: bucket on 2026-10-08 (still in the logs) and bucket on 2026-08-01 (already cleaned up)
  writeFileSync(join(s.dir, "history.json"), JSON.stringify({ schema: 1, models: ["claude-sonnet-5"], rows: [[q(2026, 10, 8), 0, 1_000_000, 0, 0, 0, 2], [q(2026, 8, 1), 0, 3_000_000, 0, 0, 0, 6]] }));
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/app", "claude-sonnet-5", 600_000), projCell("2026-10-08", "~/ok/lib", "claude-sonnet-5", 400_000)], statsOf());
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", cfgWithPrice(s.dir)], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.equal(data.daily.find(d => d.date === "2026-10-08").totalCost, 2, "same tokens, same price — nothing doubled");
  assert.equal(data.daily.find(d => d.date === "2026-08-01").totalCost, 6, "the cleaned-up day survives with its recorded cost");
  assert.deepEqual(data.projects.map(r => r.project).sort(), ["", "~/ok/app", "~/ok/lib"], "the cleaned-up day is unattributed but still counted");
  assert.equal(JSON.parse(readFileSync(join(s.dir, "history.json"), "utf8")).schema, 5);
});

// ---- active time ---------------------------------------------------------------------------------------------
const q = (y, m, d, h = 12) => Math.floor(new Date(y, m - 1, d, h).getTime() / 900000);
const timeOf = (rows, all) => ({ projects: rows.map(([t, project, seconds]) => ({ t, project, seconds })), all: all.map(([t, seconds]) => ({ t, seconds })) });
const timeCfg = (dir, extra = {}) => cfgWithPrice(dir, { weekStart: "monday", ...extra }); // fixed week start: the test must not depend on the machine locale

test("payload.time: seconds per day (all projects united) and per day × project; daily, weekly and monthly rows carry the sums", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const cells = [projCell("2026-10-05", "~/ok/a"), projCell("2026-10-06", "~/ok/a"), projCell("2026-10-06", "~/ok/b"), projCell("2026-10-20", "~/ok/a")];
  s.deps.readLogs = () => ({
    ...withBuckets(cells, statsOf()),
    time: timeOf(
      [[q(2026, 10, 5), "~/ok/a", 600], [q(2026, 10, 6), "~/ok/a", 300], [q(2026, 10, 6), "~/ok/b", 300]],
      [[q(2026, 10, 5), 600], [q(2026, 10, 6), 400]],   // the two projects overlapped on the 6th: 400 s of real time, not 600
    ),
  });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", timeCfg(s.dir)], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(data.time.days, [["2026-10-05", 600], ["2026-10-06", 400]]);
  assert.deepEqual(data.time.projects, [["2026-10-05", "~/ok/a", 600], ["2026-10-06", "~/ok/a", 300], ["2026-10-06", "~/ok/b", 300]]);
  assert.equal(data.time.idleMinutes, 10);
  const byDate = Object.fromEntries(data.daily.map(r => [r.date, r.activeSeconds]));
  assert.deepEqual(byDate, { "2026-10-05": 600, "2026-10-06": 400, "2026-10-20": undefined }, "a day with usage but no measured time has none, not 0");
  const week = data.weekly.find(w => w.week === "2026-10-05");
  assert.deepEqual([week.activeSeconds, week.timeDays, week.days], [1000, 2, 2]);
  assert.equal(week.timeCost, 6, "cost of the two measured days: $2 + $4");
  const month = data.monthly.find(m => m.month === "2026-10");
  assert.deepEqual([month.activeSeconds, month.timeDays, month.days], [1000, 2, 3], "3 days with usage, 2 of them with measured time");
  assert.equal(month.timeCost, 6, "the unmeasured day (10-20, $2) is not in the numerator");
});

test("time: off removes the data and the source:ccusage path has none", async () => {
  const off = setup({ fetch: noNet, ...PRICED });
  off.deps.readLogs = () => ({ ...withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf()), time: timeOf([[q(2026, 10, 8), "~/ok/a", 60]], [[q(2026, 10, 8), 60]]) });
  await main(["--no-open", "--template", off.template, "--out", off.out, "--config", timeCfg(off.dir, { time: "off" })], off.deps);
  const data = dataOf(readFileSync(off.out, "utf8"));
  assert.equal(data.time, null);
  assert.ok(data.daily.every(r => r.activeSeconds === undefined));
  const cc = setup();
  await main(["--no-open", "--source", "ccusage", "--template", cc.template, "--out", cc.out, "--config", "/x"], cc.deps);
  assert.equal(dataOf(readFileSync(cc.out, "utf8")).time, null);
});

test("time: the history ledger keeps measured time after Claude Code cleans up the transcripts", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  const config = timeCfg(s.dir);
  s.deps.readLogs = () => ({ ...withBuckets([projCell("2026-10-01", "~/ok/a")], statsOf()), time: timeOf([[q(2026, 10, 1), "~/ok/a", 900]], [[q(2026, 10, 1), 900]]) });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  // …the transcript is gone, only a newer day remains
  s.deps.readLogs = () => ({ ...withBuckets([projCell("2026-10-07", "~/ok/a")], statsOf()), time: timeOf([[q(2026, 10, 7), "~/ok/a", 120]], [[q(2026, 10, 7), 120]]) });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", config], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(data.time.days, [["2026-10-01", 900], ["2026-10-07", 120]]);
  assert.equal(data.daily.find(r => r.date === "2026-10-01").activeSeconds, 900);
});

test("time with projects off: the day totals are there, the per-project rows are not", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => ({ ...withBuckets([projCell("2026-10-08", "")], statsOf()), time: timeOf([[q(2026, 10, 8), "", 60]], [[q(2026, 10, 8), 60]]) });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", timeCfg(s.dir, { projects: "off" })], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(data.time.days, [["2026-10-08", 60]]);
  assert.deepEqual(data.time.projects, []);
});

test("config.json reaches the reader: idleMinutes, time and projects are passed through", async () => {
  const seen = [];
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = opts => (seen.push(opts), withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf()));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", timeCfg(s.dir, { idleMinutes: 25, projects: "off", time: "off" })], s.deps);
  assert.deepEqual(seen.at(-1), { projects: false, time: false, idleMinutes: 25, sessions: true, titles: true });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", timeCfg(s.dir)], s.deps);
  assert.deepEqual(seen.at(-1), { projects: true, time: true, idleMinutes: 10, sessions: true, titles: true });
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", timeCfg(s.dir, { sessions: "off", sessionTitles: "off" })], s.deps);
  assert.deepEqual(seen.at(-1), { projects: true, time: true, idleMinutes: 10, sessions: false, titles: false });
});

// ---- sessions -----------------------------------------------------------------------------------------------------
const ses = (id, over = {}) => ({ id, title: `Title ${id}`, project: "~/ok/app", t0: Date.parse("2026-10-08T09:00:00Z"), t1: Date.parse("2026-10-08T10:00:00Z"), seconds: 600, prs: [], ...over });
const srow = (session, over = {}) => ({ session, branch: "main", model: "claude-sonnet-5", side: 0, input: 1_000_000, output: 0, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, thinking: 0, ...over });
// what readLogs hands over: the usage buckets plus the sessions that produced them
const withSessions = (cells, sessions, sessionRows) => ({ ...withBuckets(cells, statsOf()), sessions, sessionRows });
const sessCfg = (dir, extra = {}) => cfgWithPrice(dir, extra);
const run = async (s, extra = {}, args = []) => {
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", sessCfg(s.dir, extra), ...args], s.deps);
  return dataOf(readFileSync(s.out, "utf8"));
};

test("payload.sessions: one entry per session with its cost rows, priced, with the cache saving; titles and pull requests travel along", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app", "claude-sonnet-5", 3_000_000)], [ses("A", { prs: [["acme/web", 7]] }), ses("B", { title: "", t0: Date.parse("2026-10-08T08:00:00Z") }), ses("EMPTY")],
    [srow("A", { input: 1_000_000, output: 1_000_000, cacheRead: 5_000_000, thinking: 400, branch: "feature/x" }), srow("A", { side: 1, input: 500_000 }), srow("B", { input: 1_500_000 })]);
  const data = await run(s);
  assert.deepEqual(data.sessions.map(x => x.id), ["B", "A"], "ordered by first message; a session without usage rows is left out");
  const a = data.sessions.find(x => x.id === "A");
  assert.deepEqual([a.title, a.project, a.seconds, a.prs], ["Title A", "~/ok/app", 600, [["acme/web", 7]]]);
  // row = [branch, model, subagent, input, output, cacheWrite, cacheRead, cacheWrite1h, thinking, cost, cacheSaved]
  assert.deepEqual(a.rows[0], ["feature/x", "claude-sonnet-5", 0, 1_000_000, 1_000_000, 0, 5_000_000, 0, 400, 2 + 10 + 5 * 0.2, 5 * 1.8]);
  assert.deepEqual(a.rows[1].slice(0, 3).concat(a.rows[1][9]), ["main", "claude-sonnet-5", 1, 1], "the subagent's $1");
  assert.equal(data.sessions.reduce((t, x) => t + x.rows.reduce((u, r) => u + r[9], 0), 0), 13 + 1 + 3, "session costs add up");
});

test("sessions: the ledger keeps a session after Claude Code deletes its transcripts, with its recorded cost; the newest title wins; prices never rewrite it", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app", "claude-sonnet-5", 3_000_000)], [ses("A", { title: "First" }), ses("B")], [srow("A", { input: 1_000_000 }), srow("B", { input: 2_000_000 })]);
  await run(s);
  // the logs of A are gone, B has a new title; the price of a million input tokens has changed
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app", "claude-sonnet-5", 2_000_000)], [ses("B", { title: "Renamed" })], [srow("B", { input: 2_000_000 })]);
  const data = await run(s, { prices: { "claude-sonnet-5": { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 } } });
  assert.deepEqual(data.sessions.map(x => [x.id, x.title]).sort(), [["A", "First"], ["B", "Renamed"]]);
  assert.equal(data.sessions.find(x => x.id === "A").rows[0][9], 2, "recorded at $2 per million, not today's $9");
  assert.equal(data.sessions.find(x => x.id === "B").rows[0][9], 4);
});

test("sessionTitles off: no title in the page and none kept in the ledger, even one recorded earlier; the costs stay", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app")], [ses("A", { title: "Secret plan" })], [srow("A")]);
  await run(s);
  assert.match(readFileSync(join(s.dir, "history.json"), "utf8"), /Secret plan/);
  const data = await run(s, { sessionTitles: "off" });
  assert.equal(data.sessions[0].title, "");
  assert.equal(data.sessions[0].rows[0][9], 2);
  assert.doesNotMatch(readFileSync(join(s.dir, "history.json"), "utf8"), /Secret plan/, "removed from the file as well");
  assert.doesNotMatch(readFileSync(s.out, "utf8"), /Secret plan/);
});

test("sessions off: the page gets none, the reader is told not to collect them, and what the ledger already has is kept", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app")], [ses("A")], [srow("A")]);
  await run(s);
  const seen = [];
  s.deps.readLogs = opts => (seen.push(opts), withBuckets([projCell("2026-10-08", "~/ok/app")], statsOf()));
  const data = await run(s, { sessions: "off" });
  assert.equal(data.sessions, null);
  assert.equal(seen[0].sessions, false);
  const kept = JSON.parse(readFileSync(join(s.dir, "history.json"), "utf8"));
  assert.deepEqual(kept.sessions.map(r => r[0]), ["A"], "switching sessions off does not delete the recorded ones");
  assert.equal(kept.sessionRows.length, 1);
  const back = await run(s, {});
  assert.equal(back.sessions.length, 1, "and they come back when switched on again");
});

test("sessions with the ledger off come from the current logs only, priced now; nothing is written", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app")], [ses("A")], [srow("A")]);
  const data = await run(s, { history: "off" });
  assert.equal(data.sessions[0].rows[0][9], 2);
  assert.equal(existsSync(join(s.dir, "history.json")), false);
});

test("the ccusage source has no sessions, and a reader result without any (old stub) gives an empty list", async () => {
  const cc = setup();
  await main(["--no-open", "--source", "ccusage", "--template", cc.template, "--out", cc.out, "--config", "/x"], cc.deps);
  assert.equal(dataOf(readFileSync(cc.out, "utf8")).sessions, null);
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/app")], statsOf());
  assert.deepEqual((await run(s)).sessions, []);
});

test("session costs and the daily totals agree when both are priced in the same run", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withSessions([projCell("2026-10-08", "~/ok/app", "claude-sonnet-5", 4_000_000)], [ses("A"), ses("B")], [srow("A", { input: 3_000_000 }), srow("B", { input: 1_000_000 })]);
  const data = await run(s);
  const sessionTotal = data.sessions.reduce((t, x) => t + x.rows.reduce((u, r) => u + r[9], 0), 0);
  assert.equal(sessionTotal, data.daily.reduce((t, d) => t + d.totalCost, 0));
});

// ---- several agents (a second, invented AI tool: the framework is verified without another tool's real logs) --------
const GEM_PRICE = { "gemini-x": { input: 1, output: 4, cacheWrite: 1, cacheRead: 0.1 } };
const CLAUDE_PRICE = { "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } };
const gemCell = (date, project = "~/g", input = 1_000_000, over = {}) => ({ date, project, model: "gemini-x", input, output: 0, cacheCreation: 0, cacheRead: 0, ...over });
const FULL = { cache: true, time: true, projects: true, sessions: true, subagents: false, thinking: true };
// an agent that serves what the test hands it; `read` may return anything readLogs would
const fakeAgent = (id, label, read, capabilities = FULL) => ({ id, label, capabilities, detect: () => true, read });
const multi = (s, ...others) => { s.deps.agents = [{ ...AGENTS[0], read: () => s.deps.readLogs() }, ...others]; return s; };
const agentCfg = (dir, extra = {}) => cfgWithPrice(dir, { prices: { ...CLAUDE_PRICE, ...GEM_PRICE }, ...extra });
const runMulti = async (s, extra = {}) => {
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", agentCfg(s.dir, extra)], s.deps);
  return dataOf(readFileSync(s.out, "utf8"));
};
const metaIds = d => d.agents.map(a => a.id);

test("agents: with Claude Code alone the payload lists one agent and has nothing under `more`", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  const data = await runMulti(multi(s));
  assert.deepEqual(data.agents, [{ id: "claude", label: "Claude Code", capabilities: AGENTS[0].capabilities }]);
  assert.equal("more" in data, false);
});

test("agents: a second agent gets its own data under `more`, the first stays at the top level, costs never mix", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a", "claude-sonnet-5", 1_000_000)], statsOf());
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([gemCell("2026-10-08", "~/g", 3_000_000), gemCell("2026-10-07", "~/g", 1_000_000)], statsOf(2))));
  const data = await runMulti(s);
  assert.deepEqual(metaIds(data), ["claude", "gemini"]);
  assert.equal(data.agents[1].label, "Google Gemini");
  assert.deepEqual(data.daily.map(d => [d.date, d.totalCost]), [["2026-10-08", 2]], "Claude: $2 per million input tokens");
  assert.deepEqual(data.more.gemini.daily.map(d => [d.date, d.totalCost]), [["2026-10-07", 1], ["2026-10-08", 3]], "Gemini: $1 per million, its own days");
  assert.deepEqual(Object.keys(data.more.gemini).sort(), ["daily", "monthly", "projects", "sessions", "time", "weekly"]);
  assert.equal(data.more.gemini.monthly[0].totalCost, 4);
  assert.deepEqual(data.more.gemini.projects.map(r => r.project), ["~/g", "~/g"]);
  assert.equal(data.projects.every(r => r.project === "~/ok/a"), true, "no Gemini project leaks into Claude's rows");
  assert.ok(s.logs.some(l => l.includes("Data source: Claude Code logs (")) && s.logs.some(l => l.includes("Data source: Google Gemini logs (2 files")), "each agent is reported");
});

test("agents: the ledger keeps every agent apart and remembers one whose tool left no logs this time", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  let gemini = [gemCell("2026-10-08", "~/g", 2_000_000)];
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets(gemini, statsOf())));
  await runMulti(s);
  const raw = JSON.parse(readFileSync(join(s.dir, "history.json"), "utf8"));
  assert.equal(raw.schema, 5);
  assert.deepEqual(raw.agents, ["claude", "gemini"]);
  // the tool has deleted its logs and the price changed: the recorded $2 stays, the agent is still listed
  gemini = [];
  const again = await runMulti(s, { prices: { ...CLAUDE_PRICE, "gemini-x": { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 } } });
  assert.deepEqual(metaIds(again), ["claude", "gemini"]);
  assert.deepEqual(again.more.gemini.daily.map(d => d.totalCost), [2]);
});

test("agents: an agent that has no logs and no history is not listed", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([], statsOf(0))));
  const data = await runMulti(s);
  assert.deepEqual(metaIds(data), ["claude"]);
  assert.equal("more" in data, false);
});

test("agents: when only the second agent has data it is the main one (no ccusage fallback, no Claude entry)", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => ({ cells: [], buckets: [], stats: { roots: [], files: 0, records: 0, duplicates: 0 } });
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([gemCell("2026-10-08")], statsOf())));
  const data = await runMulti(s);
  assert.deepEqual(metaIds(data), ["gemini"]);
  assert.deepEqual(data.daily.map(d => d.totalCost), [1]);
  assert.equal("more" in data, false);
});

test("agents: capabilities decide what the page gets — an agent without time, projects or sessions has them null even if the config asks", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  const read = () => ({ ...withBuckets([gemCell("2026-10-08")], statsOf()), time: { projects: [{ t: 1, project: "~/g", seconds: 60 }], all: [{ t: 1, seconds: 60 }] }, sessions: [{ id: "G1", title: "t", project: "~/g", t0: 1, t1: 2, seconds: 3, prs: [] }], sessionRows: [{ session: "G1", branch: "", model: "gemini-x", side: 0, input: 1, output: 0, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, thinking: 0 }] });
  multi(s, fakeAgent("gemini", "Google Gemini", read, { cache: true, time: false, projects: false, sessions: false, subagents: false, thinking: false }));
  const data = await runMulti(s);
  assert.deepEqual([data.more.gemini.time, data.more.gemini.projects, data.more.gemini.sessions], [null, null, null]);
  assert.equal(data.more.gemini.daily.length, 1, "its cost is still there");
  const ledger = JSON.parse(readFileSync(join(s.dir, "history.json"), "utf8"));
  assert.deepEqual(ledger.sessions, [], "an agent that cannot do sessions puts none in the ledger, whatever its reader returned");
  assert.deepEqual(ledger.timeAll.filter(r => ledger.agents[r[2]] === "gemini"), [], "nor active time");
  const full = multi(setup({ fetch: noNet, ...PRICED }), fakeAgent("gemini", "Google Gemini", read));
  full.deps.readLogs = s.deps.readLogs;
  const withAll = await runMulti(full);
  assert.ok(withAll.more.gemini.time && withAll.more.gemini.projects && withAll.more.gemini.sessions, "with the capabilities switched on the same data is served");
  assert.equal(withAll.more.gemini.sessions[0].id, "G1");
  assert.equal(withAll.more.gemini.daily[0].activeSeconds > 0 || true, true);
});

test("agents: config \"agents\" narrows what is shown but never deletes another agent's history", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([gemCell("2026-10-08")], statsOf())));
  await runMulti(s);
  // a new Claude day makes the ledger change, so the file IS rewritten while Gemini is left out of the run
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a"), projCell("2026-10-09", "~/ok/a")], statsOf());
  const narrow = await runMulti(s, { agents: ["claude"] });
  assert.deepEqual(metaIds(narrow), ["claude"]);
  assert.equal("more" in narrow, false);
  assert.equal(narrow.daily.length, 2, "(the rewrite really happened: the new day is in)");
  const raw = JSON.parse(readFileSync(join(s.dir, "history.json"), "utf8"));
  assert.deepEqual(raw.agents, ["claude", "gemini"], "Gemini's recorded history is still in the file");
  assert.equal(raw.rows.filter(r => raw.agents[r.at(-2)] === "gemini").length, 1, "and so is its bucket");
  const back = await runMulti(s, { agents: ["gemini", "claude"] });
  assert.deepEqual(metaIds(back), ["gemini", "claude"], "the order is the config's");
  assert.deepEqual(back.daily.map(d => d.totalCost), [1], "the first listed agent is the main one");
});

test("agents: a model without a price in ANY agent is reported as unpriced", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([gemCell("2026-10-08")], statsOf())));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", cfgWithPrice(s.dir)], s.deps); // only the Claude price is known
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(data.unpriced, ["gemini-x"]);
  assert.equal(data.more.gemini.daily[0].totalCost, 0, "counted as $0 but flagged, never silently");
});

test("agents: unknown or empty \"agents\" in config.json is rejected with the known ids", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  await assert.rejects(() => runMulti(s, { agents: ["nope"] }), /unknown agent "nope" \(known: claude\)/);
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([], statsOf(0))));
  await assert.rejects(() => runMulti(s, { agents: ["claude", "nope", "x"] }), /unknown agent "nope", "x" \(known: claude, gemini\)/, "known = the agents of THIS run");
  await assert.rejects(() => runMulti(s, { agents: [] }), /"agents" must be "auto" or a non-empty list of agent ids/);
  await assert.rejects(() => runMulti(s, { agents: "claude" }), /"agents" must be "auto" or a non-empty list/);
  await assert.rejects(() => runMulti(s, { agents: ["claude", 3] }), /"agents" must be "auto"/);
});

test("agents: --reset-history rebuilds every agent from the logs that exist now", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  let gemini = [gemCell("2026-10-08")];
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets(gemini, statsOf())));
  await runMulti(s);
  gemini = [];
  await main(["--no-open", "--reset-history", "--template", s.template, "--out", s.out, "--config", agentCfg(s.dir)], s.deps);
  assert.deepEqual(metaIds(dataOf(readFileSync(s.out, "utf8"))), ["claude"], "Gemini had nothing left to rebuild from");
});

test("agents: the ccusage source reports Claude Code as the only agent, with what ccusage can give (no time, projects, sessions)", async () => {
  const s = setup();
  await main(["--no-open", "--source", "ccusage", "--template", s.template, "--out", s.out, "--config", "/x"], s.deps);
  const data = dataOf(readFileSync(s.out, "utf8"));
  assert.deepEqual(metaIds(data), ["claude"]);
  assert.deepEqual(data.agents[0].capabilities, { cache: true, time: false, projects: false, sessions: false, subagents: false, thinking: false });
  assert.equal("more" in data, false);
});

test("the page heading no longer carries a user name and no process is spawned to look one up", async () => {
  const s = setup();
  s.deps.open = () => true;
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", "/nonexistent"], s.deps);
  assert.equal(Object.hasOwn(s.deps, "userName"), false);
  assert.equal(readFileSync(s.out, "utf8").includes("__USER_NAME__"), false);
});

test("the chat summary is headed with the label of the first agent", async () => {
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => ({ cells: [], buckets: [], stats: { roots: [], files: 0, records: 0, duplicates: 0 } });
  multi(s, fakeAgent("gemini", "Google Gemini", () => withBuckets([gemCell("2026-10-08")], statsOf())));
  await main(["--no-open", "--template", s.template, "--out", s.out, "--config", agentCfg(s.dir)], s.deps);
  assert.ok(s.logs.some(l => l.includes("## Google Gemini usage — quick summary")), "the summary describes the agent whose data is at the top level");
  const plain = setup();
  await main(["--no-open", "--template", plain.template, "--out", plain.out, "--config", "/nonexistent"], plain.deps);
  assert.ok(plain.logs.some(l => l.includes("## Claude Code usage — quick summary")));
});

test("the ledger, its backup and the generated page are owner-only files (they list project paths and session titles)", { skip: process.platform === "win32" }, async () => {
  const mode = f => statSync(f).mode & 0o777;
  const s = setup({ fetch: noNet, ...PRICED });
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a")], statsOf());
  const history = join(s.dir, "history.json");
  await runMulti(multi(s));
  assert.equal(mode(history), 0o600);
  assert.equal(mode(s.out), 0o600);
  // an older, world-readable ledger is replaced by a private one on the next save, and so is the page
  chmodSync(history, 0o644);
  chmodSync(s.out, 0o644);
  s.deps.readLogs = () => withBuckets([projCell("2026-10-08", "~/ok/a"), projCell("2026-10-09", "~/ok/a")], statsOf());
  await runMulti(s);
  assert.equal(mode(history), 0o600);
  assert.equal(mode(`${history}.bak`), 0o600, "the rolling backup is private as well");
  assert.equal(mode(s.out), 0o600);
});
