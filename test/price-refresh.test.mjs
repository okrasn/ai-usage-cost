import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RETRY_MS, resolvePrices } from "../lib/price-refresh.mjs";

const entry = (i, o, cw, cr) => ({ litellm_provider: "anthropic", input_cost_per_token: i / 1e6, output_cost_per_token: o / 1e6, cache_creation_input_token_cost: cw / 1e6, cache_read_input_token_cost: cr / 1e6 });
const BASE = ["a", "b", "c", "d", "e"].map(n => `claude-${n}`);
const table = (extra = {}) => ({ ...Object.fromEntries(BASE.map(n => [n, entry(1, 5, 1.25, 0.1)])), ...extra });
const okFetch = data => { const f = async () => (f.calls++, { ok: true, status: 200, json: async () => data }); f.calls = 0; return f; };
const failFetch = (msg = "getaddrinfo ENOTFOUND") => { const f = async () => { f.calls++; throw new Error(msg); }; f.calls = 0; return f; };

const T = (d, h = 10, m = 0) => new Date(2026, 9, d, h, m);   // local time
function setup({ bundledDate = "2026-10-01", bundledModels = { "claude-bundled": { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccud-pr-"));
  const bundledPath = join(dir, "prices.json");
  writeFileSync(bundledPath, JSON.stringify({ fetchedAt: bundledDate, models: bundledModels }));
  return { dir, bundledPath, cachePath: join(dir, "prices-cache.json") };
}
const run = (s, over) => resolvePrices({ bundledPath: s.bundledPath, cachePath: s.cachePath, now: T(8), log() {}, ...over });

test("first run of the day downloads, caches and reports 'refreshed'; later runs the same day use the cache", async () => {
  const s = setup(), f = okFetch(table());
  const a = await run(s, { fetchImpl: f });
  assert.equal(a.origin, "refreshed");
  assert.equal(a.asOf, "2026-10-08");
  assert.equal(a.ageDays, 0);
  assert.ok(a.table.models["claude-a"] && a.table.models["claude-bundled"], "cache is merged over the bundled table");
  assert.equal(JSON.parse(readFileSync(s.cachePath, "utf8")).schema, 1);

  const b = await run(s, { fetchImpl: f, now: T(8, 18) });
  assert.equal(f.calls, 1, "no second download the same day");
  assert.equal(b.origin, "cache");
  assert.equal(b.asOf, "2026-10-08");
});

test("the next day downloads again", async () => {
  const s = setup(), f = okFetch(table());
  await run(s, { fetchImpl: f });
  const next = await run(s, { fetchImpl: f, now: T(9, 8) });
  assert.equal(f.calls, 2);
  assert.equal(next.asOf, "2026-10-09");
});

test("offline: keeps the cached prices, says they are old, and records the failure", async () => {
  const s = setup(), good = okFetch(table({ "claude-cached-only": entry(7, 7, 7, 7) }));
  await run(s, { fetchImpl: good, now: T(1, 9) });
  const logs = [];
  const off = failFetch();
  const r = await run(s, { fetchImpl: off, now: T(8), log: m => logs.push(m) });
  assert.equal(r.origin, "cache");
  assert.equal(r.asOf, "2026-10-01");
  assert.equal(r.ageDays, 7);
  assert.equal(r.refreshFailed, true);
  assert.ok(r.table.models["claude-cached-only"], "old prices stay usable");
  assert.ok(logs.some(l => /Could not refresh prices \(getaddrinfo ENOTFOUND\) — using prices as of 2026-10-01/.test(l)));
  const saved = JSON.parse(readFileSync(s.cachePath, "utf8"));
  assert.ok(saved.lastFailedAt && saved.models["claude-cached-only"], "failure is recorded without losing the cached table");
});

test("after a failed attempt an offline machine is not retried for an hour", async () => {
  const s = setup(), off = failFetch();
  await run(s, { fetchImpl: off });
  assert.equal(off.calls, 1);
  const within = await run(s, { fetchImpl: off, now: T(8, 10, 30) });
  assert.equal(off.calls, 1, "within RETRY_MS: no attempt, no stall");
  assert.equal(within.refreshFailed, true, "the label must keep saying the refresh failed while we are backing off");
  await run(s, { fetchImpl: off, now: new Date(T(8).getTime() + RETRY_MS + 1000) });
  assert.equal(off.calls, 2);
});

test("no cache and no network: falls back to the bundled table (and says so)", async () => {
  const s = setup({ bundledDate: "2026-09-20" });
  const r = await run(s, { fetchImpl: failFetch("HTTP 503") });
  assert.equal(r.origin, "bundled");
  assert.equal(r.asOf, "2026-09-20");
  assert.equal(r.ageDays, 18);
  assert.ok(r.table.models["claude-bundled"]);
  assert.equal(r.refreshFailed, true);
});

test("mode 'off' never downloads; --refresh-prices (force) does even then", async () => {
  const s = setup(), f = okFetch(table());
  const off = await run(s, { mode: "off", fetchImpl: f });
  assert.equal(f.calls, 0);
  assert.equal(off.origin, "bundled");
  assert.equal(existsSync(s.cachePath), false, "nothing written when nothing was attempted");
  const forced = await run(s, { mode: "off", force: true, fetchImpl: f });
  assert.equal(f.calls, 1);
  assert.equal(forced.origin, "refreshed");
});

test("force bypasses 'already refreshed today' and the failure back-off", async () => {
  const s = setup(), f = okFetch(table());
  await run(s, { fetchImpl: f });
  await run(s, { fetchImpl: f, force: true });
  assert.equal(f.calls, 2);
  const off = failFetch();
  await run(setup(), { fetchImpl: off });
  const s2 = setup(); await run(s2, { fetchImpl: failFetch() });
  const g = okFetch(table());
  assert.equal((await run(s2, { fetchImpl: g, force: true })).origin, "refreshed");
});

test("a bundled table newer than the cache wins (package upgraded after the last download), models are merged", async () => {
  const s = setup({ bundledDate: "2026-10-05", bundledModels: { "claude-x": { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 }, "claude-shared": { input: 2, output: 2, cacheWrite: 2, cacheRead: 2 } } });
  writeFileSync(s.cachePath, JSON.stringify({ schema: 1, fetchedAt: T(2).toISOString(), models: { "claude-shared": { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 }, "claude-cache-only": { input: 3, output: 3, cacheWrite: 3, cacheRead: 3 } } }));
  const r = await run(s, { mode: "off" });
  assert.equal(r.origin, "bundled");
  assert.equal(r.asOf, "2026-10-05");
  assert.equal(r.table.models["claude-shared"].input, 2, "newer snapshot wins per model");
  assert.ok(r.table.models["claude-cache-only"], "models only the cache knows are kept");
});

test("config overrides win over everything", async () => {
  const s = setup();
  const r = await run(s, { mode: "off", overrides: { "claude-bundled": { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } } });
  assert.equal(r.table.models["claude-bundled"].input, 1);
});

test("a garbage download (error page, tiny or absurd table) is a failure and does not replace the cache", async () => {
  const s = setup();
  await run(s, { fetchImpl: okFetch(table()), now: T(1, 9) });
  const before = JSON.parse(readFileSync(s.cachePath, "utf8")).fetchedAt;
  for (const bad of [{ "claude-a": entry(1, 1, 1, 1) }, table({ "claude-evil": entry(1e9, 1, 1, 1) })]) {
    const r = await run(s, { fetchImpl: okFetch(bad), now: T(8), force: true });
    assert.equal(r.refreshFailed, true);
    assert.equal(r.origin, "cache");
    assert.equal(JSON.parse(readFileSync(s.cachePath, "utf8")).fetchedAt, before);
  }
  const http = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.match((await run(s, { fetchImpl: http, now: T(8), force: true, log() {} })).refreshFailed.toString(), /true/);
});

test("a corrupt or foreign-schema cache file is ignored and overwritten", async () => {
  const s = setup();
  writeFileSync(s.cachePath, "{ not json");
  assert.equal((await run(s, { fetchImpl: okFetch(table()) })).origin, "refreshed");
  writeFileSync(s.cachePath, JSON.stringify({ schema: 99, fetchedAt: T(8).toISOString(), models: { x: {} } }));
  const f = okFetch(table());
  assert.equal((await run(s, { fetchImpl: f })).origin, "refreshed", "schema mismatch → treated as no cache");
  assert.equal(f.calls, 1);
});

test("wantFresh (a model had no price) adds one more attempt, but only an hour after the last download", async () => {
  const s = setup(), f = okFetch(table());
  await run(s, { fetchImpl: f, now: T(8, 9, 0) });
  await run(s, { fetchImpl: f, now: T(8, 9, 30), wantFresh: true });
  assert.equal(f.calls, 1, "downloaded 30 minutes ago → no point asking again");
  const r = await run(s, { fetchImpl: f, now: T(8, 11, 0), wantFresh: true });
  assert.equal(f.calls, 2);
  assert.equal(r.origin, "refreshed");
});
