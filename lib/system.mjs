import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./ccusage.mjs";

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const dashboardDir = () => join(claudeDir(), "dashboard");
export const commandsDir = () => join(claudeDir(), "commands");
export const skillsDir = () => join(claudeDir(), "skills");

// Package version for the footer: package.json in the repo, `.version` in an installed copy.
export function readVersion(dir) {
  try {
    const pkg = join(dir, "package.json");
    const raw = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).version : readFileSync(join(dir, ".version"), "utf8");
    return String(raw).trim() || "";
  } catch {
    return "";
  }
}

// Greeting name from the logged-in Claude Code account; optional, falls back to "User".
export function getUserName(run = runCommand) {
  try {
    const r = run("claude", ["auth", "status", "--json"], { timeout: 5000 });
    if (r.error || r.status !== 0) return "User";
    const local = String(JSON.parse(r.stdout).email ?? "").split("@")[0];
    return local ? local[0].toUpperCase() + local.slice(1) : "User";
  } catch {
    return "User";
  }
}

// Best-effort: failing to open a browser must not fail the build.
export function openInBrowser(file, run = runCommand) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [file]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", '""', file]]
    : ["xdg-open", [file]];
  const r = run(cmd, args, { stdio: "ignore" });
  return !r.error && r.status === 0;
}
