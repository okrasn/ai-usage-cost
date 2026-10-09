#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENTS, DEFAULT_AGENT, selectAgents } from "./lib/agents/index.mjs";
import { buildPeriods } from "./lib/aggregate.mjs";
import { fetchDaily } from "./lib/ccusage.mjs";
import { loadConfig } from "./lib/config.mjs";
import { diagnose, formatDiagnosis, hasFailures } from "./lib/doctor.mjs";
import { readLogs } from "./lib/logs.mjs";
import { resolvePrices } from "./lib/price-refresh.mjs";
import { renderHtml } from "./lib/render.mjs";
import { SOURCES, loadDaily } from "./lib/source.mjs";
import { buildSummary } from "./lib/summary.mjs";
import { openInBrowser, readVersion } from "./lib/system.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: build.mjs [options]

Reads Claude Code usage and regenerates the dashboard.

Options:
  --no-open           do not open the dashboard in a browser
  --no-summary        do not print the markdown summary
  --out <file>        output HTML file     (default: index.html next to this script)
  --template <file>   template to render   (default: template.html next to this script)
  --config <file>     config JSON          (default: config.json next to this script)
  --refresh-prices    download the price table now (otherwise: once per day, cached next to this script)
  --reset-history     rebuild history.json from the logs that exist now (the old file is kept as history.json.bak)
  --offline           never download prices; use the cache / the table bundled with the package
  --doctor            check the setup (log folders, how long Claude Code keeps transcripts, ledger, prices, config) and exit; changes nothing
  --source <name>     auto | logs | ccusage (default: from config, else auto): "logs" reads the Claude Code
                      transcripts itself, "ccusage" shells out to ccusage, "auto" prefers logs
  -h, --help          show this help
`;

function parseArgs(argv) {
  const opts = { open: true, summary: true };
  const valueOf = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-open") opts.open = false;
    else if (a === "--no-summary") opts.summary = false;
    else if (a === "--out") opts.out = resolve(valueOf(i++, a));
    else if (a === "--template") opts.template = resolve(valueOf(i++, a));
    else if (a === "--config") opts.config = resolve(valueOf(i++, a));
    else if (a === "--source") {
      opts.source = valueOf(i++, a);
      if (!SOURCES.includes(opts.source)) throw new Error(`--source must be one of ${SOURCES.join(", ")}`);
    }
    else if (a === "--refresh-prices") opts.refreshPrices = true;
    else if (a === "--offline") opts.offline = true;
    else if (a === "--doctor") opts.doctor = true;
    else if (a === "--reset-history") opts.resetHistory = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown option: ${a} (see --help)`);
  }
  if (opts.refreshPrices && opts.offline) throw new Error("--refresh-prices and --offline contradict each other");
  return opts;
}

// Chart.js is inlined (vendor/chart.umd.js, MIT) so the dashboard is one offline file.
function readChartJs() {
  const file = join(HERE, "vendor", "chart.umd.js");
  if (!existsSync(file)) throw new Error(`missing ${file} — reinstall the package (npm run copy-dashboard -- --force)`);
  return readFileSync(file, "utf8");
}

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 }); // the page lists project paths and session titles too
  renameSync(tmp, file);
}

export async function main(argv, deps = {}) {
  const {
    fetch = fetchDaily,
    readLogs: readLogsDep = readLogs,
    pricesPath = join(HERE, "vendor", "prices.json"),
    pricesCachePath = join(HERE, "prices-cache.json"),
    historyPath = join(HERE, "history.json"),
    fetchImpl,
    agents: registryDep,
    open = openInBrowser,
    now = new Date(),
    env = process.env,
    home = homedir(),
    log = console.log,
  } = deps;

  const opts = parseArgs(argv);
  // the AI tools to read: every agent this version knows (config "agents" narrows it); Claude Code's reader can be swapped in tests
  const registry = registryDep ?? AGENTS.map(a => (a.id === DEFAULT_AGENT ? { ...a, read: readLogsDep } : a));
  if (opts.help) {
    log(HELP);
    return 0;
  }

  const out = opts.out ?? join(HERE, "index.html");
  if (opts.doctor) {
    const configPath = opts.config ?? join(HERE, "config.json");
    let historyEnabled = true;
    try {
      historyEnabled = loadConfig(configPath).history === "on";
    } catch {
      // an invalid config is reported by the check itself
    }
    const items = diagnose({ agents: registry, env, home, now, historyPath, pricesPath, pricesCachePath, configPath, outPath: out, historyEnabled });
    log(formatDiagnosis(items));
    return hasFailures(items) ? 1 : 0;
  }
  const config = loadConfig(opts.config ?? join(HERE, "config.json"));
  const template = readFileSync(opts.template ?? join(HERE, "template.html"), "utf8");
  const chartJs = template.includes("__CHARTJS__") ? readChartJs() : "";

  const getPrices = (extra = {}) =>
    resolvePrices({
      bundledPath: pricesPath,
      cachePath: pricesCachePath,
      overrides: config.prices,
      mode: opts.offline ? "off" : config.priceRefresh,
      force: Boolean(opts.refreshPrices),
      now,
      url: config.priceUrl ?? undefined,
      fetchImpl,
      log,
      ...extra,
    });
  const readOpts = { projects: config.projects === "on", time: config.time === "on", idleMinutes: config.idleMinutes, sessions: config.sessions === "on", titles: config.sessionTitles === "on" };
  const agentList = selectAgents(config.agents, registry).map(a => ({ id: a.id, label: a.label, capabilities: a.capabilities, read: () => a.read(readOpts) }));
  const { daily, unpriced, source, prices, history, projects, time, sessions, agents, extra } = await loadDaily({
    source: opts.source ?? config.source,
    agents: agentList,
    fetchCcusage: fetch,
    getPrices,
    history: { enabled: config.history === "on", path: historyPath, reset: Boolean(opts.resetHistory), now },
    projects: { enabled: config.projects === "on", now },
    time: { enabled: config.time === "on", idleMinutes: config.idleMinutes },
    sessions: { enabled: config.sessions === "on", titles: config.sessionTitles === "on" },
    log,
  });
  // one agent's data as the page wants it: the active seconds of each day ride on its rows (so weekly / monthly rows can add
  // them up), weekly and monthly rows are derived from the daily ones
  const finish = view => {
    const seconds = new Map(view.time?.days ?? []);
    for (const row of view.daily) if (seconds.has(row.date)) row.activeSeconds = seconds.get(row.date);
    const periods = buildPeriods(view.daily, { weekStart: config.weekStart });
    return { daily: periods.daily, weekly: periods.weekly, monthly: periods.monthly, projects: view.projects, time: view.time, sessions: view.sessions };
  };
  // the first agent's data sits at the top level, the page's other agents (if any) under `more`, by id
  const more = Object.fromEntries(Object.entries(extra).map(([id, view]) => [id, finish(view)]));
  const payload = {
    ...finish({ daily, projects, time, sessions }),
    generatedAt: now.toISOString(),
    version: readVersion(HERE),
    source,
    unpriced,
    prices,
    history,
    agents,
    ...(Object.keys(more).length ? { more } : {}),
  };
  writeAtomic(out, renderHtml(template, payload, chartJs));

  if (opts.summary) log(buildSummary(daily, now, { unpriced, prices, label: agents[0].label })); // the summary is of the first agent, like the top level of the payload
  log(`Dashboard regenerated: ${out}`);
  if (process.env.TERM_PROGRAM === "vscode") {
    log("\nInside VS Code? Open in Simple Browser instead of a separate window:");
    log(`  Cmd+Shift+P → 'Simple Browser: Show' → ${pathToFileURL(out).href}`);
  }
  if (opts.open && !open(out)) {
    log(`Could not open a browser automatically — open this file manually: ${pathToFileURL(out).href}`);
  }
  return 0;
}

const isDirectRun = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(`ai-usage-cost: ${e.message}`);
    process.exitCode = 1;
  }
}
