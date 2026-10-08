#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPeriods } from "./lib/aggregate.mjs";
import { fetchDaily } from "./lib/ccusage.mjs";
import { loadConfig } from "./lib/config.mjs";
import { readLogs } from "./lib/logs.mjs";
import { resolvePrices } from "./lib/price-refresh.mjs";
import { renderHtml } from "./lib/render.mjs";
import { SOURCES, loadDaily } from "./lib/source.mjs";
import { buildSummary } from "./lib/summary.mjs";
import { getUserName, openInBrowser, readVersion } from "./lib/system.mjs";

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
  writeFileSync(tmp, content, "utf8");
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
    userName = getUserName,
    open = openInBrowser,
    now = new Date(),
    log = console.log,
  } = deps;

  const opts = parseArgs(argv);
  if (opts.help) {
    log(HELP);
    return 0;
  }

  const out = opts.out ?? join(HERE, "index.html");
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
  const { daily, unpriced, source, prices, history } = await loadDaily({
    source: opts.source ?? config.source,
    readLogs: readLogsDep,
    fetchCcusage: fetch,
    getPrices,
    history: { enabled: config.history === "on", path: historyPath, reset: Boolean(opts.resetHistory), now },
    log,
  });
  const periods = buildPeriods(daily, { weekStart: config.weekStart });
  const payload = {
    daily: periods.daily,
    weekly: periods.weekly,
    monthly: periods.monthly,
    generatedAt: now.toISOString(),
    version: readVersion(HERE),
    source,
    unpriced,
    prices,
    history,
  };
  writeAtomic(out, renderHtml(template, payload, userName(), chartJs));

  if (opts.summary) log(buildSummary(daily, now, { unpriced, prices }));
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
    console.error(`ccusage-ui-dashboard: ${e.message}`);
    process.exitCode = 1;
  }
}
