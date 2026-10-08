#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { PREFIX_RE, installDashboard, installSkill, installedPrefixes } from "../lib/install.mjs";
import { commandsDir, dashboardDir, skillsDir } from "../lib/system.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Usage: install.mjs [--dashboard | --skill] [--prefix <name>] [--force]

  (no flag)     install the dashboard files and the /<prefix>-usage skill
  --dashboard   install only the dashboard files into <claude dir>/dashboard
  --skill       install only the skill into <claude dir>/skills/<prefix>-usage (--command is a deprecated alias;
                a slash command installed by <= 1.2.x is removed and replaced by the skill)
  --prefix      skill prefix: /<prefix>-usage (or set CC_USAGE_PREFIX)
  --force       reinstall even if the installed version is current, or overwrite a foreign skill file

<claude dir> is $CLAUDE_CONFIG_DIR or ~/.claude.
`;

function parseArgs(argv) {
  const o = { dashboard: false, skill: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dashboard") o.dashboard = true;
    else if (a === "--skill" || a === "--command") o.skill = true;
    else if (a === "--force") o.force = true;
    else if (a === "--prefix") o.prefix = argv[++i];
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown option: ${a} (see --help)`);
  }
  if (!o.dashboard && !o.skill) o.dashboard = o.skill = true;
  return o;
}

async function resolvePrefix(opts) {
  let prefix = opts.prefix ?? process.env.CC_USAGE_PREFIX;
  if (!prefix) {
    const existing = installedPrefixes({ skillsDir: skillsDir(), commandsDir: commandsDir() })[0];
    const fallback = existing ?? "my";
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Prefix (the skill will be invoked as /<prefix>-usage) [${fallback}]: `);
      rl.close();
      prefix = answer.trim() || fallback;
    } else {
      prefix = fallback;
    }
  }
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`Invalid prefix: '${prefix}' (allowed: a-z, A-Z, 0-9, -, _)`);
  }
  return prefix;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  const pkgVersion = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;

  if (opts.skill) {
    const prefix = await resolvePrefix(opts);
    if (opts.dashboard && opts.skill) console.log(`Using skill: /${prefix}-usage\n`);
    if (opts.dashboard) installDashboard({ srcRoot: SRC, dstDir: dashboardDir(), pkgVersion, force: opts.force });
    installSkill({
      srcRoot: SRC,
      skillsDir: skillsDir(),
      commandsDir: commandsDir(),
      dashboardDir: dashboardDir(),
      useTilde: process.platform !== "win32" && !process.env.CLAUDE_CONFIG_DIR,
      prefix,
      pkgVersion,
      force: opts.force,
    });
  } else {
    installDashboard({ srcRoot: SRC, dstDir: dashboardDir(), pkgVersion, force: opts.force });
  }
}

main().catch(e => {
  console.error(`ccusage-ui-dashboard: ${e.message}`);
  process.exitCode = 1;
});
