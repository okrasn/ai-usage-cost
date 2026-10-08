#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPeriods } from "./lib/aggregate.mjs";
import { fetchDaily } from "./lib/ccusage.mjs";
import { loadConfig } from "./lib/config.mjs";
import { normalizeDaily } from "./lib/normalize.mjs";
import { renderHtml } from "./lib/render.mjs";
import { buildSummary } from "./lib/summary.mjs";
import { getUserName, openInBrowser, readVersion } from "./lib/system.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `Usage: build.mjs [options]

Reads Claude Code usage via ccusage and regenerates the dashboard.

Options:
  --no-open           do not open the dashboard in a browser
  --no-summary        do not print the markdown summary
  --out <file>        output HTML file     (default: index.html next to this script)
  --template <file>   template to render   (default: template.html next to this script)
  --config <file>     config JSON          (default: config.json next to this script)
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
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown option: ${a} (see --help)`);
  }
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

export function main(argv, deps = {}) {
  const {
    fetch = fetchDaily,
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

  const daily = normalizeDaily(fetch());
  const periods = buildPeriods(daily, { weekStart: config.weekStart });
  const payload = {
    daily: periods.daily,
    weekly: periods.weekly,
    monthly: periods.monthly,
    generatedAt: now.toISOString(),
    version: readVersion(HERE),
  };
  writeAtomic(out, renderHtml(template, payload, userName(), chartJs));

  if (opts.summary) log(buildSummary(daily, now));
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
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`ccusage-ui-dashboard: ${e.message}`);
    process.exitCode = 1;
  }
}
