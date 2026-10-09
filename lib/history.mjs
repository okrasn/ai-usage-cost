import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { costOf } from "./pricing.mjs";

// history.json — a durable, text-free ledger of usage, so that Claude Code's own cleanup of old transcripts
// (`cleanupPeriodDays`, 30 days by default) does not erase the dashboard's past.
//
// Per 15-minute UTC bucket, project (working directory, relative to ~) and model it stores the token counts AND the cost, priced with the table in force when the
// bucket was first seen. A later price change never rewrites what you already spent: 100 dollars in August stay
// 100 dollars even if the same tokens cost 50 in September. If a bucket grows (activity inside the current window)
// only the growth is priced at today's rates and added; a bucket whose model had no price is stored with
// `cost: null` and priced as soon as a price is known. UTC buckets instead of local days make the ledger independent
// of the time zone it was recorded in (days are derived at read time), so travelling cannot double-count an hour.
// Merging with fresh logs is a per-field maximum: cleanup can only shrink a bucket, activity can only grow it.
export const SCHEMA = 3; // 2 = before active time, 1 = before the project dimension (both read, never written)
export const EMPTY_TIME = Object.freeze({ projects: [], all: [] });
const FIELDS = ["input", "output", "cacheCreation", "cacheRead"];

export function loadHistory(path, log = () => {}) {
  if (!path || !existsSync(path)) return { buckets: [], time: EMPTY_TIME, status: "absent" };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return quarantine(path, "not valid JSON", log);
  }
  if (raw && typeof raw.schema === "number" && raw.schema > SCHEMA) {
    log(`History file ${path} was written by a newer version (schema ${raw.schema}) — it is used read-only and not modified.`);
    return { buckets: decode(raw) ?? [], time: decodeTime(raw) ?? EMPTY_TIME, status: "newer" };
  }
  const buckets = raw?.schema === SCHEMA || raw?.schema === 2 ? decode(raw) : raw?.schema === 1 ? decodeV1(raw) : null;
  const time = raw?.schema === SCHEMA ? decodeTime(raw) : EMPTY_TIME;
  return buckets && time ? { buckets, time, status: "ok" } : quarantine(path, "unexpected structure", log);
}

const validRow = (r, n) => Array.isArray(r) && r.length === n && r.slice(0, n - 1).every(Number.isFinite) && (r[n - 1] === null || Number.isFinite(r[n - 1]));

// active seconds per 15-minute bucket: per project and over all projects (the real total, parallel work counted once)
function decodeTime(raw) {
  if (raw.timeProjects === undefined && raw.timeAll === undefined) return EMPTY_TIME;
  if (!Array.isArray(raw.timeProjects) || !Array.isArray(raw.timeAll) || !Array.isArray(raw.projects)) return null;
  const projects = [];
  for (const r of raw.timeProjects) {
    if (!Array.isArray(r) || r.length !== 3 || !r.every(Number.isFinite) || typeof raw.projects[r[1]] !== "string") return null;
    projects.push({ t: r[0], project: raw.projects[r[1]], seconds: r[2] });
  }
  const all = [];
  for (const r of raw.timeAll) {
    if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isFinite)) return null;
    all.push({ t: r[0], seconds: r[1] });
  }
  return { projects, all };
}

function decode(raw) {
  if (!Array.isArray(raw.models) || !Array.isArray(raw.projects) || !Array.isArray(raw.rows)) return null;
  const out = [];
  for (const r of raw.rows) {
    if (!validRow(r, 8) || typeof raw.projects[r[1]] !== "string" || typeof raw.models[r[2]] !== "string") return null;
    out.push({ t: r[0], project: raw.projects[r[1]], model: raw.models[r[2]], input: r[3], output: r[4], cacheCreation: r[5], cacheRead: r[6], cost: r[7] });
  }
  return out;
}

// Schema 1 had no project: its rows become project "" and are flagged `legacy`, so that mergeBuckets can replace them
// with project-attributed rows wherever the current logs still cover the same bucket.
function decodeV1(raw) {
  if (!Array.isArray(raw.models) || !Array.isArray(raw.rows)) return null;
  const out = [];
  for (const r of raw.rows) {
    if (!validRow(r, 7) || typeof raw.models[r[1]] !== "string") return null;
    out.push({ t: r[0], project: "", legacy: true, model: raw.models[r[1]], input: r[2], output: r[3], cacheCreation: r[4], cacheRead: r[5], cost: r[6] });
  }
  return out;
}

// Never overwrite something we cannot read: move it aside, so nothing is lost silently.
function quarantine(path, why, log) {
  const aside = `${path}.corrupt-${Date.now()}`;
  renameSync(path, aside);
  log(`History file was unreadable (${why}); kept as ${aside} and started a new one.`);
  return { buckets: [], time: EMPTY_TIME, status: "quarantined" };
}

const priced = (tokens, price) => (price ? costOf(tokens, price) : null);

// Per-field maximum, like the tokens: cleanup can only shrink what the logs still show, activity can only grow it.
export function mergeTime(ledger, fresh) {
  let changed = false;
  const merge = (a, b, key) => {
    const map = new Map(a.map(r => [key(r), { ...r }]));
    for (const r of b) {
      const cur = map.get(key(r));
      if (!cur) { map.set(key(r), { ...r }); changed = true; }
      else if (r.seconds > cur.seconds) { cur.seconds = r.seconds; changed = true; }
    }
    return [...map.values()].sort((x, y) => x.t - y.t || (x.project ?? "").localeCompare(y.project ?? ""));
  };
  const projects = merge(ledger.projects, fresh.projects, r => `${r.t}\t${r.project}`);
  const all = merge(ledger.all, fresh.all, r => String(r.t));
  return { time: { projects, all }, changed };
}

const keyOf = b => `${b.t}\t${b.project ?? ""}\t${b.model}`;

// priceFor(model) → rates or null (the table in force NOW). Ledger buckets keep the cost they were recorded with.
export function mergeBuckets(ledger, fresh, priceFor = () => null) {
  // A legacy (schema 1, project-less) row is superseded wherever the current logs have project-attributed rows for the
  // same bucket and model: those rows are the same tokens, now with a project (and priced today).
  const attributed = new Set(fresh.filter(f => (f.project ?? "") !== "").map(f => `${f.t}\t${f.model}`));
  let changed = false;
  const map = new Map();
  for (const b of ledger) {
    if (b.legacy && attributed.has(`${b.t}\t${b.model}`)) {
      changed = true;
      continue;
    }
    const { legacy, ...rest } = b;
    if (legacy) changed = true; // a legacy row that survives must be rewritten in the new format
    map.set(keyOf(b), { ...rest, project: b.project ?? "", cost: b.cost ?? null });
  }
  for (const f of fresh) {
    const k = keyOf(f);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { t: f.t, project: f.project ?? "", model: f.model, input: f.input, output: f.output, cacheCreation: f.cacheCreation, cacheRead: f.cacheRead, cost: priced(f, priceFor(f.model)) });
      changed = true;
      continue;
    }
    const grown = Object.fromEntries(FIELDS.map(field => [field, Math.max(0, f[field] - cur[field])]));
    if (!FIELDS.some(field => grown[field] > 0)) continue;
    for (const field of FIELDS) cur[field] += grown[field];
    // only the growth is priced at today's rates; what was already recorded keeps its price
    cur.cost = cur.cost === null ? priced(cur, priceFor(cur.model)) : cur.cost + (priced(grown, priceFor(cur.model)) ?? 0);
    changed = true;
  }
  for (const cur of map.values()) {
    if (cur.cost === null) {
      const c = priced(cur, priceFor(cur.model)); // a price became known since this bucket was recorded
      if (c !== null) {
        cur.cost = c;
        changed = true;
      }
    }
  }
  return { buckets: [...map.values()].sort((a, b) => a.t - b.t || a.project.localeCompare(b.project) || a.model.localeCompare(b.model)), changed };
}

export function saveHistory(path, buckets, now = new Date(), time = EMPTY_TIME) {
  const models = [...new Set(buckets.map(b => b.model))].sort();
  const projects = [...new Set([...buckets.map(b => b.project ?? ""), ...time.projects.map(r => r.project)])].sort();
  const modelIndex = new Map(models.map((m, i) => [m, i]));
  const projectIndex = new Map(projects.map((p, i) => [p, i]));
  const data = {
    schema: SCHEMA,
    note: "Tokens and cost (USD, priced when first seen) per 15-minute UTC bucket, project (cwd relative to ~) and model, plus active seconds; no prompts. Written by ccusage-ui-dashboard.",
    updatedAt: now.toISOString(),
    models,
    projects,
    rows: buckets.map(b => [b.t, projectIndex.get(b.project ?? ""), modelIndex.get(b.model), b.input, b.output, b.cacheCreation, b.cacheRead, b.cost ?? null]),
    timeProjects: time.projects.map(r => [r.t, projectIndex.get(r.project), r.seconds]),
    timeAll: time.all.map(r => [r.t, r.seconds]),
  };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`); // one rolling backup of the previous good state
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}
