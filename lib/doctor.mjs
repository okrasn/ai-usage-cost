import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENTS } from "./agents/index.mjs";
import { loadConfig } from "./config.mjs";
import { SCHEMA, peekHistory } from "./history.mjs";
import { bucketDate, jsonlFiles, logRoots } from "./logs.mjs";

// `--doctor`: a read-only health check that answers "why does the dashboard look like this?" — where the logs are, how
// long Claude Code keeps them, whether the ledger is healthy, how old the prices are. It never downloads, writes,
// moves or creates anything. Returns [{ level: "ok" | "info" | "warn" | "fail", text }].
const QUARTER = 15 * 60 * 1000;
const DAY = 86400000;
const ymd = ms => bucketDate(Math.floor(ms / QUARTER));
const size = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const ago = (ms, now) => {
  const d = Math.floor((now - ms) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};
const readJson = path => {
  try {
    return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
};

export function diagnose({ agents = AGENTS, env = process.env, home = homedir(), nodeVersion = process.versions.node, platform = process.platform, now = new Date(), historyPath, pricesPath, pricesCachePath, configPath, outPath, historyEnabled = true } = {}) {
  const out = [];
  const add = (level, text) => out.push({ level, text });

  const major = Number(String(nodeVersion).split(".")[0]);
  if (major >= 18) add("ok", `Node ${nodeVersion}`);
  else add("fail", `Node ${nodeVersion} — this tool needs Node 18 or newer`);

  // ---- the AI tools this version can read, and which of them have logs here
  const found = agents.filter(a => a.detect({ env, home }));
  add("info", `AI tools this version can read: ${agents.map(a => `${a.label} (${found.includes(a) ? "logs found" : "no logs here"})`).join(", ")}`);

  // ---- Claude Code logs and how long Claude Code keeps them
  const roots = logRoots({ env, home });
  let oldest = Infinity;
  if (!roots.length) {
    const hint = "No Claude Code log directory found (looked at $CLAUDE_CONFIG_DIR, ~/.config/claude/projects, ~/.claude/projects)";
    if (found.length) add("info", `${hint} — the other tools above are read instead`);
    else add("fail", `${hint} — there is nothing to read`);
  }
  for (const root of roots) {
    let files = [];
    try {
      files = jsonlFiles(root).map(f => statSync(f));
    } catch (e) {
      add("fail", `${root}: cannot be read (${e.code ?? e.message})`);
      continue;
    }
    const bytes = files.reduce((s, f) => s + f.size, 0);
    const first = Math.min(...files.map(f => f.mtimeMs));
    const last = Math.max(...files.map(f => f.mtimeMs));
    if (files.length) oldest = Math.min(oldest, first);
    add(files.length ? "ok" : "warn", files.length
      ? `Claude Code logs: ${root} — ${files.length} transcripts, ${size(bytes)}; oldest touched ${ymd(first)} (${ago(first, now)}), newest ${ymd(last)} (${ago(last, now)})`
      : `Claude Code logs: ${root} exists but holds no transcripts`);
    const settingsFile = join(dirname(root), "settings.json");
    const days = readJson(settingsFile)?.cleanupPeriodDays;
    if (Number.isFinite(days)) {
      add("ok", `cleanupPeriodDays = ${days} (${settingsFile}): Claude Code deletes transcripts after ${days} days`);
    } else if (historyEnabled) {
      add("info", "cleanupPeriodDays is not set: Claude Code deletes transcripts after 30 days (its default). The history ledger keeps the older days for you");
    } else {
      add("warn", "cleanupPeriodDays is not set (Claude Code deletes transcripts after 30 days) and the history ledger is off — older usage will disappear. Set \"history\": \"on\" in config.json");
    }
  }

  // ---- history ledger
  if (!historyEnabled) {
    add("info", "History ledger is off (\"history\": \"off\")");
  } else {
    const h = peekHistory(historyPath);
    if (!h.exists) {
      add("info", `No history ledger yet (${historyPath}) — it is created by the first build`);
    } else if (h.error) {
      add("fail", `History ledger ${historyPath} is unreadable (${h.error}) — the next build moves it aside as history.json.corrupt-<time> and starts a new one; history.json.bak is the previous good copy`);
    } else if (h.schema > SCHEMA) {
      add("warn", `History ledger was written by a newer version (schema ${h.schema}, this one writes ${SCHEMA}) — it is used read-only`);
    } else {
      const span = h.firstT === null ? "empty" : `${h.rows.toLocaleString("en-US")} rows from ${ymd(h.firstT * QUARTER)} to ${ymd(h.lastT * QUARTER)}`;
      add("ok", `History ledger: ${historyPath} — schema ${h.schema}${h.schema < SCHEMA ? ` (upgraded to ${SCHEMA} by the next build)` : ""}, ${span}${h.sessions ? `, ${h.sessions} sessions` : ""}, ${size(h.size)}, updated ${h.updatedAt ?? "n/a"}`);
      if (Number.isFinite(oldest) && h.firstT !== null && h.firstT * QUARTER > oldest + DAY) {
        add("info", `The ledger starts ${ymd(h.firstT * QUARTER)}, after the oldest transcript (${ymd(oldest)}): earlier days only exist in the logs and are added on the next build`);
      }
    }
    if (h.exists && platform !== "win32" && (h.mode & 0o077)) {
      add("warn", `${historyPath} is readable by other users (mode ${h.mode.toString(8)}) and lists your project paths — run: chmod 600 "${historyPath}"`);
    }
  }

  // ---- prices
  const bundled = readJson(pricesPath);
  const cache = readJson(pricesCachePath);
  const dates = [bundled?.fetchedAt, cache?.fetchedAt].filter(Boolean).map(v => ({ v, ms: Date.parse(v) })).filter(x => Number.isFinite(x.ms));
  if (!dates.length) {
    add("fail", "No price table found (vendor/prices.json missing) — costs cannot be computed");
  } else {
    const newest = dates.sort((a, b) => b.ms - a.ms)[0];
    const age = Math.floor((now - newest.ms) / DAY);
    const origin = cache?.fetchedAt && newest.v === cache.fetchedAt ? "downloaded" : "bundled with the package";
    add(age >= 7 ? "warn" : "ok", `Prices: ${origin}, as of ${ymd(newest.ms)} (${ago(newest.ms, now)})${age >= 7 ? " — outdated; run with --refresh-prices" : ""}`);
    if (cache?.lastFailedAt) add("info", `The last price download failed at ${cache.lastFailedAt}; the next attempt waits up to an hour`);
  }

  // ---- config and output
  try {
    loadConfig(configPath);
    add("ok", configPath && existsSync(configPath) ? `Config: ${configPath} is valid` : "Config: no config.json — defaults are used");
  } catch (e) {
    add("fail", `Config: ${e.message}`);
  }
  try {
    accessSync(dirname(outPath), constants.W_OK);
    add("ok", `Output: ${outPath} can be written`);
  } catch {
    add("fail", `Output: ${dirname(outPath)} is not writable — use --out <file>`);
  }
  return out;
}

const MARK = { ok: "✓", info: "ℹ", warn: "⚠", fail: "✗" };
export const formatDiagnosis = items => ["ai-usage-cost doctor", ...items.map(i => `  ${MARK[i.level]} ${i.text}`)].join("\n");
export const hasFailures = items => items.some(i => i.level === "fail");
