import { existsSync, readFileSync } from "node:fs";
import { WEEK_START_VALUES } from "./aggregate.mjs";

const DEFAULTS = { weekStart: "auto" };

// config.json lives next to build.mjs and is never touched by the installer.
export function loadConfig(path) {
  if (!path || !existsSync(path)) return { ...DEFAULTS };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const cfg = { ...DEFAULTS, ...raw };
  if (!WEEK_START_VALUES.includes(String(cfg.weekStart).toLowerCase())) {
    throw new Error(`${path}: "weekStart" must be one of ${WEEK_START_VALUES.join(", ")}`);
  }
  return cfg;
}
