import { spawnSync } from "node:child_process";

const MAX_BUFFER = 512 * 1024 * 1024;

export function runCommand(cmd, args, opts = {}) {
  // On Windows npx/ccusage are .cmd shims, which need a shell to be spawned.
  return spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    shell: process.platform === "win32",
    windowsHide: true,
    ...opts,
  });
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // tolerate banners/warnings printed around the JSON document
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("ccusage did not print JSON");
    return JSON.parse(text.slice(start, end + 1));
  }
}

// ccusage >= 19 mixes every detected coding agent in `daily`; `claude daily` keeps
// the Claude-only report (and the classic row shape). Older versions have no
// `claude` subcommand, so fall back to plain `daily`.
const ATTEMPTS = [
  ["claude", "daily", "--json", "--breakdown"],
  ["daily", "--json", "--breakdown"],
];

// One-line reason out of a (possibly stack-trace-shaped) stderr dump.
export function failureReason(text) {
  const lines = String(text).split("\n").map(l => l.trim()).filter(Boolean);
  const hit = lines.find(l => /^\w*Error\b/.test(l)) ?? lines.find(l => /\berror\b/i.test(l) && !/^(at|throw)\b/.test(l));
  return (hit ?? lines.at(-1) ?? "").slice(0, 300);
}

export function fetchDaily({ run = runCommand } = {}) {
  const failures = [];
  for (const args of ATTEMPTS) {
    const r = run("npx", ["--yes", "ccusage", ...args]);
    const label = `ccusage ${args.slice(0, args[0] === "claude" ? 2 : 1).join(" ")}`;
    if (r.error) {
      failures.push(`${label}: ${r.error.message}`);
      continue;
    }
    if (r.status !== 0) {
      const why = failureReason(r.stderr || r.stdout || "");
      failures.push(`${label}: exit ${r.status}${why ? ` (${why})` : ""}`);
      continue;
    }
    try {
      return parseJson(r.stdout);
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
    }
  }
  throw new Error(
    "could not read usage data from ccusage (needs npx and ccusage >= 12.4.0).\n  " + failures.join("\n  ")
  );
}
