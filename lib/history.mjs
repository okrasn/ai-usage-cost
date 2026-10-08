import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { costOf } from "./pricing.mjs";

// history.json — a durable, text-free ledger of usage, so that Claude Code's own cleanup of old transcripts
// (`cleanupPeriodDays`, 30 days by default) does not erase the dashboard's past.
//
// Per 15-minute UTC bucket and model it stores the token counts AND the cost, priced with the table in force when the
// bucket was first seen. A later price change never rewrites what you already spent: 100 dollars in August stay
// 100 dollars even if the same tokens cost 50 in September. If a bucket grows (activity inside the current window)
// only the growth is priced at today's rates and added; a bucket whose model had no price is stored with
// `cost: null` and priced as soon as a price is known. UTC buckets instead of local days make the ledger independent
// of the time zone it was recorded in (days are derived at read time), so travelling cannot double-count an hour.
// Merging with fresh logs is a per-field maximum: cleanup can only shrink a bucket, activity can only grow it.
export const SCHEMA = 1;
const FIELDS = ["input", "output", "cacheCreation", "cacheRead"];

export function loadHistory(path, log = () => {}) {
  if (!path || !existsSync(path)) return { buckets: [], status: "absent" };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return quarantine(path, "not valid JSON", log);
  }
  if (raw && typeof raw.schema === "number" && raw.schema > SCHEMA) {
    log(`History file ${path} was written by a newer version (schema ${raw.schema}) — it is used read-only and not modified.`);
    return { buckets: decode(raw) ?? [], status: "newer" };
  }
  const buckets = raw?.schema === SCHEMA ? decode(raw) : null;
  return buckets ? { buckets, status: "ok" } : quarantine(path, "unexpected structure", log);
}

function decode(raw) {
  if (!Array.isArray(raw.models) || !Array.isArray(raw.rows)) return null;
  const out = [];
  for (const r of raw.rows) {
    const ok = Array.isArray(r) && r.length === 7 && r.slice(0, 6).every(Number.isFinite) && (r[6] === null || Number.isFinite(r[6]));
    if (!ok || typeof raw.models[r[1]] !== "string") return null;
    out.push({ t: r[0], model: raw.models[r[1]], input: r[2], output: r[3], cacheCreation: r[4], cacheRead: r[5], cost: r[6] });
  }
  return out;
}

// Never overwrite something we cannot read: move it aside, so nothing is lost silently.
function quarantine(path, why, log) {
  const aside = `${path}.corrupt-${Date.now()}`;
  renameSync(path, aside);
  log(`History file was unreadable (${why}); kept as ${aside} and started a new one.`);
  return { buckets: [], status: "quarantined" };
}

const priced = (tokens, price) => (price ? costOf(tokens, price) : null);

// priceFor(model) → rates or null (the table in force NOW). Ledger buckets keep the cost they were recorded with.
export function mergeBuckets(ledger, fresh, priceFor = () => null) {
  const map = new Map(ledger.map(b => [`${b.t}\t${b.model}`, { ...b, cost: b.cost ?? null }]));
  let changed = false;
  for (const f of fresh) {
    const k = `${f.t}\t${f.model}`;
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { t: f.t, model: f.model, input: f.input, output: f.output, cacheCreation: f.cacheCreation, cacheRead: f.cacheRead, cost: priced(f, priceFor(f.model)) });
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
  return { buckets: [...map.values()].sort((a, b) => a.t - b.t || a.model.localeCompare(b.model)), changed };
}

export function saveHistory(path, buckets, now = new Date()) {
  const models = [...new Set(buckets.map(b => b.model))].sort();
  const index = new Map(models.map((m, i) => [m, i]));
  const data = {
    schema: SCHEMA,
    note: "Tokens and cost (USD, priced when first seen) per 15-minute UTC bucket and model; no prompts. Written by ccusage-ui-dashboard.",
    updatedAt: now.toISOString(),
    models,
    rows: buckets.map(b => [b.t, index.get(b.model), b.input, b.output, b.cacheCreation, b.cacheRead, b.cost ?? null]),
  };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`); // one rolling backup of the previous good state
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}
