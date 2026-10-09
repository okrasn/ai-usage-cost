import { existsSync, readFileSync } from "node:fs";
import { WEEK_START_VALUES } from "./aggregate.mjs";
import { SOURCES } from "./source.mjs";

const DEFAULTS = { weekStart: "auto", source: "auto", agents: "auto", prices: {}, priceRefresh: "daily", priceUrl: null, history: "on", projects: "on", time: "on", sessions: "on", sessionTitles: "on", idleMinutes: 10 };
const RATE_KEYS = ["input", "output", "cacheWrite", "cacheRead"];

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
  if (!SOURCES.includes(cfg.source)) {
    throw new Error(`${path}: "source" must be one of ${SOURCES.join(", ")}`);
  }
  // which ids exist is checked where the agents are chosen (selectAgents), against the agents this run really has
  if (cfg.agents !== "auto" && !(Array.isArray(cfg.agents) && cfg.agents.length > 0 && cfg.agents.every(id => typeof id === "string" && id))) {
    throw new Error(`${path}: "agents" must be "auto" or a non-empty list of agent ids, e.g. ["claude"]`);
  }
  if (!["on", "off"].includes(cfg.time)) {
    throw new Error(`${path}: "time" must be "on" or "off"`);
  }
  if (!Number.isFinite(cfg.idleMinutes) || cfg.idleMinutes < 1 || cfg.idleMinutes > 240) {
    throw new Error(`${path}: "idleMinutes" must be a number between 1 and 240`);
  }
  for (const key of ["sessions", "sessionTitles"]) {
    if (!["on", "off"].includes(cfg[key])) throw new Error(`${path}: "${key}" must be "on" or "off"`);
  }
  if (!["on", "off"].includes(cfg.projects)) {
    throw new Error(`${path}: "projects" must be "on" or "off"`);
  }
  if (!["on", "off"].includes(cfg.history)) {
    throw new Error(`${path}: "history" must be "on" or "off"`);
  }
  if (!["daily", "off"].includes(cfg.priceRefresh)) {
    throw new Error(`${path}: "priceRefresh" must be "daily" or "off"`);
  }
  if (cfg.priceUrl !== null && !/^https?:\/\//.test(String(cfg.priceUrl))) {
    throw new Error(`${path}: "priceUrl" must be an http(s) URL of a LiteLLM-format price table`);
  }
  if (cfg.prices === null || typeof cfg.prices !== "object" || Array.isArray(cfg.prices)) {
    throw new Error(`${path}: "prices" must be an object of model → rates`);
  }
  for (const [model, rates] of Object.entries(cfg.prices)) {
    const ok = rates && typeof rates === "object" && RATE_KEYS.every(k => Number.isFinite(rates[k]) && rates[k] >= 0);
    if (!ok) throw new Error(`${path}: prices["${model}"] needs non-negative numbers (USD per million tokens) for ${RATE_KEYS.join(", ")}`);
  }
  return cfg;
}
