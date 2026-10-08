import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const PREFIX_RE = /^[a-zA-Z0-9_-]+$/;

// Semver precedence for the subset we publish: X.Y.Z with an optional -prerelease.
export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ""] = String(v).trim().replace(/^v/, "").split(/-(.*)/s);
    return { nums: core.split(".").map(n => parseInt(n, 10) || 0), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1; // release > prerelease
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p < +q ? -1 : 1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]
  );
}

const readVersion = file => (existsSync(file) ? readFileSync(file, "utf8").trim() : "0.0.0");
const same = (a, b) => existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);

// Files that make up the installed dashboard (relative to the package root); the installer itself stays behind.
export function dashboardFiles(srcRoot) {
  const files = ["build.mjs", "template.html"];
  for (const sub of ["lib", "vendor"]) {
    const dir = join(srcRoot, sub);
    if (existsSync(dir) && statSync(dir).isDirectory()) files.push(...listFiles(dir).map(f => relative(srcRoot, f)).filter(f => f !== join("lib", "install.mjs")));
  }
  return files;
}

export function installDashboard({ srcRoot, dstDir, pkgVersion, force = false, log = console.log }) {
  if (same(srcRoot, dstDir)) return log(`Package is already at ${dstDir} — nothing to copy.`);
  const versionFile = join(dstDir, ".version");
  const installed = readVersion(versionFile);
  const fresh = !existsSync(join(dstDir, "build.mjs"));
  if (!fresh && !force && compareVersions(pkgVersion, installed) <= 0) {
    return log(`Dashboard files already at ${dstDir} (v${installed} ≥ v${pkgVersion}) — skipping. Use --force to reinstall.`);
  }
  for (const rel of dashboardFiles(srcRoot)) {
    mkdirSync(dirname(join(dstDir, rel)), { recursive: true });
    copyFileSync(join(srcRoot, rel), join(dstDir, rel));
  }
  chmodSync(join(dstDir, "build.mjs"), 0o755);
  // <= 1.1.x installed a bash+python3 `build.sh`; skills, symlinks and shell aliases may still call it,
  // so keep that path working as a one-line shim over build.mjs instead of deleting it.
  const legacy = join(dstDir, "build.sh");
  if (existsSync(legacy)) {
    writeFileSync(legacy, `#!/usr/bin/env bash\n# Compatibility shim: the generator is now build.mjs.\nexec node "${join(dstDir, "build.mjs")}" "$@"\n`);
    chmodSync(legacy, 0o755);
  }
  writeFileSync(versionFile, `${pkgVersion}\n`);
  // config.json is the user's own file and is never touched here.
  log(fresh ? `Dashboard files installed to ${dstDir} (v${pkgVersion})` : `Dashboard files upgraded at ${dstDir} (v${installed} → v${pkgVersion})`);
}

// Prefixes of slash commands that this package installed (they have a version marker).
export function installedPrefixes(commandsDir) {
  if (!existsSync(commandsDir)) return [];
  return readdirSync(commandsDir)
    .filter(f => f.endsWith("-usage.md") && existsSync(join(commandsDir, `.${f.slice(0, -3)}.version`)))
    .map(f => f.slice(0, -"-usage.md".length))
    .sort();
}

// `~/.claude/...` is only valid for the default location on a POSIX shell; otherwise embed the absolute path.
export function buildCommandLine(dashboardDir, { useTilde = false } = {}) {
  return useTilde ? "node ~/.claude/dashboard/build.mjs" : `node "${join(dashboardDir, "build.mjs")}"`;
}

export function installCommand({ srcRoot, commandsDir, dashboardDir, useTilde, prefix, pkgVersion, force = false, log = console.log }) {
  const name = `${prefix}-usage`;
  const dst = join(commandsDir, `${name}.md`);
  const versionFile = join(commandsDir, `.${name}.version`);
  const exists = existsSync(dst);
  const ours = existsSync(versionFile);

  if (exists && !ours && !force) {
    throw new Error(
      `${dst} already exists and was not installed by this package — refusing to overwrite it.\n` +
        "  Pick another prefix (CC_USAGE_PREFIX=<prefix>) or pass --force."
    );
  }
  const installed = readVersion(versionFile);
  if (exists && ours && !force && compareVersions(pkgVersion, installed) <= 0) {
    return log(`Slash command already at ${dst} (v${installed} ≥ v${pkgVersion}) — skipping. Use --force to reinstall.`);
  }
  const body = readFileSync(join(srcRoot, "commands", "ok-usage.md"), "utf8").replace(
    "__BUILD_CMD__",
    buildCommandLine(dashboardDir, { useTilde })
  );
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(dst, body);
  writeFileSync(versionFile, `${pkgVersion}\n`);
  if (exists && ours) log(`Slash command upgraded at ${dst} (v${installed} → v${pkgVersion}, /${name})`);
  else {
    log(`Slash command installed to ${dst} (v${pkgVersion})`);
    log(`It will be available as /${name} in any Claude Code session.`);
  }
}
