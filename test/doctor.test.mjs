import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../build.mjs";
import { diagnose, formatDiagnosis, hasFailures } from "../lib/doctor.mjs";
import { SCHEMA, saveHistory } from "../lib/history.mjs";

const NOW = new Date("2026-10-09T12:00:00Z");
const day = s => new Date(`${s}T12:00:00Z`);
const bucketOf = s => Math.floor(day(s).getTime() / 900000);

// a Claude config dir with one transcript last touched on `touched`, optional settings, ledger and price files
function world({ touched = "2026-10-08", settings, ledger, mode = 0o600, bundledAt = "2026-10-08", cache, config, haveLogs = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccud-doctor-"));
  const claude = join(dir, "claude");
  mkdirSync(join(claude, "projects", "p"), { recursive: true });
  if (haveLogs) {
    const f = join(claude, "projects", "p", "s.jsonl");
    writeFileSync(f, '{"type":"user"}\n');
    utimesSync(f, day(touched), day(touched));
  } else {
    mkdirSync(join(dir, "none"));
  }
  if (settings) writeFileSync(join(claude, "settings.json"), JSON.stringify(settings));
  const historyPath = join(dir, "history.json");
  if (ledger !== undefined) {
    writeFileSync(historyPath, typeof ledger === "string" ? ledger : JSON.stringify(ledger));
    chmodSync(historyPath, mode);
  }
  const pricesPath = join(dir, "prices.json");
  if (bundledAt) writeFileSync(pricesPath, JSON.stringify({ fetchedAt: bundledAt, models: {} }));
  const pricesCachePath = join(dir, "prices-cache.json");
  if (cache) writeFileSync(pricesCachePath, JSON.stringify(cache));
  const configPath = join(dir, "config.json");
  if (config !== undefined) writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
  return { dir, opts: { env: { CLAUDE_CONFIG_DIR: haveLogs ? claude : join(dir, "none") }, home: dir, now: NOW, historyPath, pricesPath, pricesCachePath, configPath, outPath: join(dir, "index.html") } };
}
const ledgerOf = (firstDay, schema = SCHEMA) => ({ schema, updatedAt: "2026-10-08T20:00:00.000Z", models: ["m"], projects: [""], rows: [[bucketOf(firstDay), 0, 0, 1, 1, 1, 1, 0.5], [bucketOf("2026-10-08"), 0, 0, 1, 1, 1, 1, 0.5]] });
const lines = items => items.map(i => `${i.level}: ${i.text}`);
const levels = items => items.map(i => i.level);

test("doctor: a healthy setup has only ok / info lines and no failure", () => {
  const w = world({ settings: { cleanupPeriodDays: 90 }, ledger: ledgerOf("2026-09-08") });
  const items = diagnose(w.opts);
  assert.equal(hasFailures(items), false);
  assert.ok(!levels(items).includes("warn"), lines(items).join("\n"));
  const text = lines(items).join("\n");
  assert.match(text, /ok: Node /);
  assert.match(text, /ok: Claude Code logs: .*1 transcripts?.*oldest touched 2026-10-08 \(yesterday\)/);
  assert.match(text, /ok: cleanupPeriodDays = 90 .*deletes transcripts after 90 days/);
  assert.match(text, new RegExp(`ok: History ledger: .*schema ${SCHEMA}, 2 rows from 2026-09-08 to 2026-10-08`));
  assert.doesNotMatch(text, /sessions,/, "an empty sessions table is not mentioned");
  assert.match(lines(diagnose(world({ ledger: { ...ledgerOf("2026-09-08"), sessions: [["S1", "", 0, 1, 2, 3, []], ["S2", "", 0, 1, 2, 3, []]] } }).opts)).join("\n"), /2 rows from 2026-09-08 to 2026-10-08, 2 sessions, 1 KB/);
  assert.match(text, /ok: Prices: bundled with the package, as of 2026-10-08 \(yesterday\)/);
  assert.match(text, /ok: Config: no config.json — defaults are used/);
  assert.match(text, /ok: Output: .*index.html can be written/);
});

test("doctor: no log directory, or an old Node, is a failure", () => {
  const none = diagnose(world({ haveLogs: false }).opts);
  assert.equal(hasFailures(none), true);
  assert.match(lines(none).join("\n"), /fail: No Claude Code log directory found/);
  const old = diagnose({ ...world().opts, nodeVersion: "16.20.2" });
  assert.match(lines(old).join("\n"), /fail: Node 16\.20\.2 — this tool needs Node 18 or newer/);
  assert.equal(diagnose({ ...world().opts, nodeVersion: "18.0.0" }).some(i => i.level === "fail"), false, "18 is the floor");
});

test("doctor: cleanupPeriodDays unset is information with the ledger on and a warning with it off", () => {
  const w = world();
  const on = lines(diagnose(w.opts)).join("\n");
  assert.match(on, /info: cleanupPeriodDays is not set: Claude Code deletes transcripts after 30 days \(its default\)\. The history ledger keeps/);
  const off = lines(diagnose({ ...w.opts, historyEnabled: false })).join("\n");
  assert.match(off, /warn: cleanupPeriodDays is not set .*history ledger is off/);
  assert.match(off, /info: History ledger is off/);
});

test("doctor: ledger states — absent, unreadable, newer, older schema, starting after the oldest transcript", () => {
  assert.match(lines(diagnose(world().opts)).join("\n"), /info: No history ledger yet/);
  const bad = diagnose(world({ ledger: "{ not json" }).opts);
  assert.match(lines(bad).join("\n"), /fail: History ledger .* is unreadable \(not valid JSON\).*history\.json\.bak/);
  const newer = lines(diagnose(world({ ledger: ledgerOf("2026-10-01", 99) }).opts)).join("\n");
  assert.match(newer, /warn: History ledger was written by a newer version \(schema 99, this one writes \d+\) — it is used read-only/);
  const older = lines(diagnose(world({ ledger: ledgerOf("2026-10-01", 1) }).opts)).join("\n");
  assert.match(older, /schema 1 \(upgraded to \d+ by the next build\)/);
  const late = lines(diagnose(world({ touched: "2026-09-01", ledger: ledgerOf("2026-10-01") }).opts)).join("\n");
  assert.match(late, /info: The ledger starts 2026-10-01, after the oldest transcript \(2026-09-01\)/);
});

test("doctor: a ledger readable by other users is flagged with the chmod command (not on Windows)", { skip: process.platform === "win32" }, () => {
  const w = world({ ledger: ledgerOf("2026-10-01"), mode: 0o644 });
  const text = lines(diagnose(w.opts)).join("\n");
  assert.match(text, /warn: .*history\.json is readable by other users \(mode 644\) and lists your project paths — run: chmod 600 /);
  assert.ok(!lines(diagnose(world({ ledger: ledgerOf("2026-10-01"), mode: 0o600 }).opts)).join("\n").includes("readable by other users"));
  assert.match(lines(diagnose(world({ ledger: ledgerOf("2026-10-01"), mode: 0o640 }).opts)).join("\n"), /readable by other users \(mode 640\)/, "group-readable counts too");
});

test("doctor: prices — a week old or more is a warning, none at all a failure; a download beats the bundled table; a failed download is mentioned", () => {
  const old = lines(diagnose(world({ bundledAt: "2026-10-01" }).opts)).join("\n");
  assert.match(old, /warn: Prices: bundled with the package, as of 2026-10-01 \(8 days ago\) — outdated; run with --refresh-prices/);
  const six = lines(diagnose(world({ bundledAt: "2026-10-03" }).opts)).join("\n");
  assert.match(six, /ok: Prices: .*2026-10-03/);
  assert.match(lines(diagnose(world({ bundledAt: "2026-10-02" }).opts)).join("\n"), /warn: Prices: .*2026-10-02 \(7 days ago\) — outdated/, "seven days is already outdated");
  const none = diagnose(world({ bundledAt: null }).opts);
  assert.match(lines(none).join("\n"), /fail: No price table found/);
  const cached = lines(diagnose(world({ bundledAt: "2026-10-01", cache: { schema: 1, fetchedAt: "2026-10-09T08:00:00.000Z", lastFailedAt: "2026-10-09T09:00:00.000Z", models: {} } }).opts)).join("\n");
  assert.match(cached, /ok: Prices: downloaded, as of 2026-10-09 \(today\)/);
  assert.match(cached, /info: The last price download failed at 2026-10-09T09:00:00.000Z/);
});

test("doctor: an invalid config and an unwritable output location are failures with the reason", () => {
  const badCfg = diagnose(world({ config: '{"weekStart":"someday"}' }).opts);
  assert.match(lines(badCfg).join("\n"), /fail: Config: .*"weekStart" must be one of/);
  const good = lines(diagnose(world({ config: { weekStart: "monday" } }).opts)).join("\n");
  assert.match(good, /ok: Config: .*config\.json is valid/);
  const w = world();
  const out = diagnose({ ...w.opts, outPath: join(w.dir, "missing-dir", "index.html") });
  assert.match(lines(out).join("\n"), /fail: Output: .*missing-dir is not writable — use --out <file>/);
});

test("doctor: it only reads — nothing is created, moved or rewritten, not even a damaged ledger", () => {
  const w = world({ ledger: "{ not json", settings: { cleanupPeriodDays: 30 } });
  const listing = () => readdirSync(w.dir, { recursive: true }).sort().join("|");
  const before = listing();
  const ledgerBefore = readFileSync(w.opts.historyPath, "utf8");
  diagnose(w.opts);
  assert.equal(listing(), before, "no file appeared or moved (no .corrupt-*, no .bak, no prices-cache)");
  assert.equal(readFileSync(w.opts.historyPath, "utf8"), ledgerBefore);
});

test("--doctor: prints the report, exits 0 / 1, reads no logs, downloads nothing and writes no dashboard", async () => {
  const w = world();
  const logs = [];
  const boom = () => { throw new Error("must not be called"); };
  const deps = { log: m => logs.push(m), readLogs: boom, fetch: boom, fetchImpl: boom, open: boom, now: NOW, env: w.opts.env, home: w.dir, pricesPath: w.opts.pricesPath, pricesCachePath: w.opts.pricesCachePath, historyPath: w.opts.historyPath };
  const code = await main(["--doctor", "--config", w.opts.configPath, "--out", w.opts.outPath], deps);
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /^ai-usage-cost doctor\n  ✓ Node /);
  assert.equal(existsSync(w.opts.outPath), false, "no dashboard was written");
  assert.equal(existsSync(w.opts.pricesCachePath), false);
  const none = world({ haveLogs: false });
  const code2 = await main(["--doctor", "--config", none.opts.configPath, "--out", none.opts.outPath], { ...deps, log: () => {}, env: none.opts.env, home: none.dir, pricesPath: none.opts.pricesPath, pricesCachePath: none.opts.pricesCachePath, historyPath: none.opts.historyPath });
  assert.equal(code2, 1, "a failed check is a non-zero exit");
  const broken = world({ config: "{nope" });
  const code3 = await main(["--doctor", "--config", broken.opts.configPath, "--out", broken.opts.outPath], { ...deps, log: m => logs.push(m), env: broken.opts.env, home: broken.dir, pricesPath: broken.opts.pricesPath, pricesCachePath: broken.opts.pricesCachePath, historyPath: broken.opts.historyPath });
  assert.equal(code3, 1, "even an unparsable config does not crash the doctor");
});

test("--doctor reads the history switch from config.json", async () => {
  const w = world({ config: { history: "off" } });
  const logs = [];
  await main(["--doctor", "--config", w.opts.configPath, "--out", w.opts.outPath], { log: m => logs.push(m), now: NOW, env: w.opts.env, home: w.dir, pricesPath: w.opts.pricesPath, pricesCachePath: w.opts.pricesCachePath, historyPath: w.opts.historyPath });
  assert.match(logs.join("\n"), /History ledger is off/);
  assert.match(logs.join("\n"), /⚠ cleanupPeriodDays is not set .*history ledger is off/);
});

test("doctor: the report format marks every level", () => {
  const text = formatDiagnosis([{ level: "ok", text: "a" }, { level: "info", text: "b" }, { level: "warn", text: "c" }, { level: "fail", text: "d" }]);
  assert.equal(text, "ai-usage-cost doctor\n  ✓ a\n  ℹ b\n  ⚠ c\n  ✗ d");
});

test("--help lists --doctor", async () => {
  const logs = [];
  await main(["--help"], { log: m => logs.push(m) });
  assert.match(logs.join("\n"), /--doctor\s+check the setup/);
});

// ---- the AI tools (agents) -----------------------------------------------------------------------------------------
const agentOf = (id, label, found) => ({ id, label, capabilities: {}, detect: () => found, read: () => ({}) });

test("doctor: lists the AI tools this version can read and which of them have logs on this machine", () => {
  const w = world();
  assert.match(lines(diagnose(w.opts)).join("\n"), /info: AI tools this version can read: Claude Code \(logs found\)/);
  const mixed = lines(diagnose({ ...w.opts, agents: [agentOf("claude", "Claude Code", true), agentOf("gemini", "Google Gemini", false), agentOf("codex", "OpenAI Codex", true)] })).join("\n");
  assert.match(mixed, /info: AI tools this version can read: Claude Code \(logs found\), Google Gemini \(no logs here\), OpenAI Codex \(logs found\)/);
});

test("doctor: no Claude Code folder is a failure only when no other tool has logs either", () => {
  const w = world({ haveLogs: false });
  const alone = diagnose({ ...w.opts, agents: [agentOf("claude", "Claude Code", false)] });
  assert.equal(hasFailures(alone), true);
  assert.match(lines(alone).join("\n"), /fail: No Claude Code log directory found .* there is nothing to read/);
  const other = diagnose({ ...w.opts, agents: [agentOf("claude", "Claude Code", false), agentOf("gemini", "Google Gemini", true)] });
  assert.equal(hasFailures(other), false);
  assert.match(lines(other).join("\n"), /info: No Claude Code log directory found .* the other tools above are read instead/);
  assert.doesNotMatch(lines(other).join("\n"), /nothing to read/);
});

test("--doctor passes the run's agents on (a test-registry or a config-narrowed list is what gets reported)", async () => {
  const w = world();
  const logs = [];
  const deps = { log: m => logs.push(m), now: NOW, env: w.opts.env, home: w.dir, pricesPath: w.opts.pricesPath, pricesCachePath: w.opts.pricesCachePath, historyPath: w.opts.historyPath, agents: [agentOf("claude", "Claude Code", true), agentOf("gemini", "Google Gemini", false)] };
  await main(["--doctor", "--config", w.opts.configPath, "--out", w.opts.outPath], deps);
  assert.match(logs.join("\n"), /Claude Code \(logs found\), Google Gemini \(no logs here\)/);
});

test("doctor: a ledger written by this version raises no permission warning (it is created owner-only)", { skip: process.platform === "win32" }, () => {
  const w = world();
  saveHistory(w.opts.historyPath, [{ t: 1, project: "", model: "m", input: 1, output: 1, cacheCreation: 0, cacheRead: 0, cost: 1 }], new Date());
  assert.doesNotMatch(lines(diagnose(w.opts)).join("\n"), /readable by other users/);
  assert.match(lines(diagnose(w.opts)).join("\n"), /ok: History ledger/);
});
