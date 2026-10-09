import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_AGENT } from "./agents/index.mjs";
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
export const SCHEMA = 5; // 4 = before the agent dimension, 3 = before sessions / 1-hour cache writes, 2 = before active time, 1 = before projects (all read, never written)
export const EMPTY_TIME = Object.freeze({ projects: [], all: [] });
const FIELDS = ["input", "output", "cacheCreation", "cacheCreation1h", "cacheRead"];
const SESSION_FIELDS = [...FIELDS, "thinking"];
const emptyLedger = status => ({ buckets: [], time: EMPTY_TIME, sessions: [], sessionRows: [], status });

// Schema 5 adds the agent (the AI tool the usage came from: "claude", later others) to every row — buckets, active time,
// sessions. Older files had one source, so their rows are read as agent "claude". Each agent is merged on its own (the
// merge functions below work on one agent's rows); pipeline code splits and joins by `agent`.
//
// Schema 4 adds the sessions: one row per Claude Code session (title, project, first/last message, active seconds, linked
// pull requests) and its cost per branch × model × subagent flag — priced and merged exactly like the buckets. The title is
// the only text-derived field in this file (it can be switched off with "sessionTitles": "off").

export function loadHistory(path, log = () => {}) {
  if (!path || !existsSync(path)) return emptyLedger("absent");
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return quarantine(path, "not valid JSON", log);
  }
  if (raw && typeof raw.schema === "number" && raw.schema > SCHEMA) {
    log(`History file ${path} was written by a newer version (schema ${raw.schema}) — it is used read-only and not modified.`);
    return { buckets: decode(raw) ?? [], time: decodeTime(raw) ?? EMPTY_TIME, ...(decodeSessions(raw) ?? { sessions: [], sessionRows: [] }), status: "newer" };
  }
  const buckets = raw?.schema >= 2 && raw.schema <= SCHEMA ? decode(raw) : raw?.schema === 1 ? decodeV1(raw) : null;
  const time = raw?.schema >= 3 && raw.schema <= SCHEMA ? decodeTime(raw) : EMPTY_TIME;
  const sessions = raw?.schema >= 4 && raw.schema <= SCHEMA ? decodeSessions(raw) : { sessions: [], sessionRows: [] };
  return buckets && time && sessions ? { buckets, time, ...sessions, status: "ok" } : quarantine(path, "unexpected structure", log);
}

// the agent of a row: its index into raw.agents (schema 5), or the one agent older files knew; null = a broken index
const agentOf = (raw, index) => (index === null ? DEFAULT_AGENT : Array.isArray(raw.agents) && typeof raw.agents[index] === "string" ? raw.agents[index] : null);
const validRow = (r, n) => Array.isArray(r) && r.length === n && r.slice(0, n - 1).every(Number.isFinite) && (r[n - 1] === null || Number.isFinite(r[n - 1]));

// active seconds per 15-minute bucket: per project and over all projects (the real total, parallel work counted once)
function decodeTime(raw) {
  if (raw.timeProjects === undefined && raw.timeAll === undefined) return EMPTY_TIME;
  if (!Array.isArray(raw.timeProjects) || !Array.isArray(raw.timeAll) || !Array.isArray(raw.projects)) return null;
  const projects = [];
  for (const r of raw.timeProjects) { // [t, project, seconds] or, from schema 5, [t, project, seconds, agent]
    if (!Array.isArray(r) || (r.length !== 3 && r.length !== 4) || !r.every(Number.isFinite) || typeof raw.projects[r[1]] !== "string") return null;
    const agent = agentOf(raw, r.length === 4 ? r[3] : null);
    if (agent === null) return null;
    projects.push({ t: r[0], project: raw.projects[r[1]], seconds: r[2], agent });
  }
  const all = [];
  for (const r of raw.timeAll) { // [t, seconds] or [t, seconds, agent]
    if (!Array.isArray(r) || (r.length !== 2 && r.length !== 3) || !r.every(Number.isFinite)) return null;
    const agent = agentOf(raw, r.length === 3 ? r[2] : null);
    if (agent === null) return null;
    all.push({ t: r[0], seconds: r[1], agent });
  }
  return { projects, all };
}

// bucket rows: [t, project, model, input, output, cacheWrite, cacheRead, cost] (schema 2–3),
// [t, project, model, input, output, cacheWrite, cacheRead, cacheWrite1h, cost] (schema 4) or
// [t, project, model, input, output, cacheWrite, cacheRead, cacheWrite1h, agent, cost] (schema 5)
function decode(raw) {
  if (!Array.isArray(raw.models) || !Array.isArray(raw.projects) || !Array.isArray(raw.rows)) return null;
  const out = [];
  for (const r of raw.rows) {
    const n = Array.isArray(r) ? r.length : 0;
    if ((n < 8 || n > 10) || !validRow(r, n) || typeof raw.projects[r[1]] !== "string" || typeof raw.models[r[2]] !== "string") return null;
    const agent = agentOf(raw, n === 10 ? r[8] : null);
    if (agent === null) return null;
    out.push({ t: r[0], project: raw.projects[r[1]], model: raw.models[r[2]], input: r[3], output: r[4], cacheCreation: r[5], cacheCreation1h: n >= 9 ? r[7] : 0, cacheRead: r[6], agent, cost: r[n - 1] });
  }
  return out;
}

// sessions: [id, title, project, firstMs, lastMs, activeSeconds, [[repo, number]…]] (+ agent from schema 5)
// session rows: [session, branch, model, subagent 0/1, input, output, cacheWrite, cacheWrite1h, cacheRead, thinking, cost]
function decodeSessions(raw) {
  if (raw.sessions === undefined && raw.sessionRows === undefined) return { sessions: [], sessionRows: [] };
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.sessionRows) || !Array.isArray(raw.branches) || !Array.isArray(raw.models) || !Array.isArray(raw.projects)) return null;
  const sessions = [];
  for (const r of raw.sessions) {
    if (!Array.isArray(r) || (r.length !== 7 && r.length !== 8) || typeof r[0] !== "string" || typeof r[1] !== "string" || typeof raw.projects[r[2]] !== "string") return null;
    if (![r[3], r[4], r[5]].every(Number.isFinite) || !Array.isArray(r[6]) || !r[6].every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && Number.isInteger(p[1]))) return null;
    const agent = agentOf(raw, r.length === 8 ? r[7] : null);
    if (agent === null) return null;
    sessions.push({ id: r[0], title: r[1], project: raw.projects[r[2]], t0: r[3], t1: r[4], seconds: r[5], prs: r[6].map(p => [p[0], p[1]]), agent });
  }
  const sessionRows = [];
  for (const r of raw.sessionRows) {
    if (!validRow(r, 11) || !sessions[r[0]] || typeof raw.branches[r[1]] !== "string" || typeof raw.models[r[2]] !== "string") return null;
    sessionRows.push({ session: sessions[r[0]].id, agent: sessions[r[0]].agent, branch: raw.branches[r[1]], model: raw.models[r[2]], side: r[3], input: r[4], output: r[5], cacheCreation: r[6], cacheCreation1h: r[7], cacheRead: r[8], thinking: r[9], cost: r[10] });
  }
  return { sessions, sessionRows };
}

// Schema 1 had no project: its rows become project "" and are flagged `legacy`, so that mergeBuckets can replace them
// with project-attributed rows wherever the current logs still cover the same bucket.
function decodeV1(raw) {
  if (!Array.isArray(raw.models) || !Array.isArray(raw.rows)) return null;
  const out = [];
  for (const r of raw.rows) {
    if (!validRow(r, 7) || typeof raw.models[r[1]] !== "string") return null;
    out.push({ t: r[0], project: "", legacy: true, model: raw.models[r[1]], input: r[2], output: r[3], cacheCreation: r[4], cacheCreation1h: 0, cacheRead: r[5], agent: DEFAULT_AGENT, cost: r[6] });
  }
  return out;
}

// Never overwrite something we cannot read: move it aside, so nothing is lost silently.
function quarantine(path, why, log) {
  const aside = `${path}.corrupt-${Date.now()}`;
  renameSync(path, aside);
  log(`History file was unreadable (${why}); kept as ${aside} and started a new one.`);
  return emptyLedger("quarantined");
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
const sessionKeyOf = r => `${r.session}\t${r.branch}\t${r.model}\t${r.side}`;

// Shared by buckets and session rows. Per-field maximum against what the ledger holds; a row that is new is priced now,
// a row that grew has only its growth priced (at today's rates), a row whose model had no price is priced as soon as one is known.
function mergeKeyed(ledger, fresh, { keyOf, fields, priceFor }) {
  let changed = false;
  const map = new Map();
  for (const r of ledger) map.set(keyOf(r), { ...r, cost: r.cost ?? null });
  for (const f of fresh) {
    const k = keyOf(f);
    const cur = map.get(k);
    if (!cur) {
      const row = { ...f };
      for (const field of fields) row[field] = f[field] || 0;
      row.cost = priced(row, priceFor(f.model));
      map.set(k, row);
      changed = true;
      continue;
    }
    const grown = Object.fromEntries(fields.map(field => [field, Math.max(0, (f[field] || 0) - (cur[field] || 0))]));
    if (!fields.some(field => grown[field] > 0)) continue;
    for (const field of fields) cur[field] = (cur[field] || 0) + grown[field];
    // only the growth is priced at today's rates; what was already recorded keeps its price
    cur.cost = cur.cost === null ? priced(cur, priceFor(cur.model)) : cur.cost + (priced(grown, priceFor(cur.model)) ?? 0);
    changed = true;
  }
  for (const cur of map.values()) {
    if (cur.cost === null) {
      const c = priced(cur, priceFor(cur.model)); // a price became known since this row was recorded
      if (c !== null) {
        cur.cost = c;
        changed = true;
      }
    }
  }
  return { rows: [...map.values()], changed };
}

// priceFor(model) → rates or null (the table in force NOW). Ledger buckets keep the cost they were recorded with.
export function mergeBuckets(ledger, fresh, priceFor = () => null) {
  // A legacy (schema 1, project-less) row is superseded wherever the current logs have project-attributed rows for the
  // same bucket and model: those rows are the same tokens, now with a project (and priced today).
  const attributed = new Set(fresh.filter(f => (f.project ?? "") !== "").map(f => `${f.t}\t${f.model}`));
  let legacyChanged = false;
  const kept = [];
  for (const b of ledger) {
    if (b.legacy && attributed.has(`${b.t}\t${b.model}`)) {
      legacyChanged = true;
      continue;
    }
    const { legacy, ...rest } = b;
    if (legacy) legacyChanged = true; // a legacy row that survives must be rewritten in the new format
    kept.push({ ...rest, project: b.project ?? "" });
  }
  const { rows, changed } = mergeKeyed(kept, fresh.map(f => ({ ...f, project: f.project ?? "" })), { keyOf, fields: FIELDS, priceFor });
  return { buckets: rows.sort((a, b) => a.t - b.t || a.project.localeCompare(b.project) || a.model.localeCompare(b.model)), changed: changed || legacyChanged };
}

export function mergeSessionRows(ledger, fresh, priceFor = () => null) {
  const { rows, changed } = mergeKeyed(ledger, fresh, { keyOf: sessionKeyOf, fields: SESSION_FIELDS, priceFor });
  return { rows: rows.sort((a, b) => a.session.localeCompare(b.session) || a.branch.localeCompare(b.branch) || a.model.localeCompare(b.model) || a.side - b.side), changed };
}

// Session metadata: the title Claude Code generated (the newest non-empty one wins), the first / last message and the active
// time only ever widen, pull requests are a union.
export function mergeSessions(ledger, fresh) {
  let changed = false;
  const map = new Map(ledger.map(s => [s.id, { ...s, prs: s.prs.map(p => [...p]) }]));
  for (const f of fresh) {
    const cur = map.get(f.id);
    if (!cur) {
      map.set(f.id, { ...f, prs: f.prs.map(p => [...p]) });
      changed = true;
      continue;
    }
    const prs = new Map(cur.prs.map(p => [`${p[0]}#${p[1]}`, p]));
    for (const p of f.prs) prs.set(`${p[0]}#${p[1]}`, [...p]);
    const next = { id: cur.id, agent: cur.agent, title: f.title || cur.title, project: f.project || cur.project, t0: Math.min(cur.t0, f.t0), t1: Math.max(cur.t1, f.t1), seconds: Math.max(cur.seconds, f.seconds), prs: [...prs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]) };
    if (next.title !== cur.title || next.project !== cur.project || next.t0 !== cur.t0 || next.t1 !== cur.t1 || next.seconds !== cur.seconds || next.prs.length !== cur.prs.length) changed = true;
    map.set(f.id, next);
  }
  return { sessions: [...map.values()].sort((a, b) => a.t0 - b.t0 || a.id.localeCompare(b.id)), changed };
}

// Read-only look at the ledger for `--doctor`: unlike loadHistory it never moves a damaged file aside.
export function peekHistory(path) {
  if (!path || !existsSync(path)) return { exists: false };
  const st = statSync(path);
  const base = { exists: true, size: st.size, mode: st.mode & 0o777 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const ts = Array.isArray(raw.rows) ? raw.rows.map(r => r?.[0]).filter(Number.isFinite) : [];
    return { ...base, schema: raw.schema, updatedAt: raw.updatedAt ?? null, sessions: Array.isArray(raw.sessions) ? raw.sessions.length : 0, rows: ts.length, firstT: ts.length ? Math.min(...ts) : null, lastT: ts.length ? Math.max(...ts) : null };
  } catch {
    return { ...base, error: "not valid JSON" };
  }
}

export function saveHistory(path, buckets, now = new Date(), time = EMPTY_TIME, { sessions = [], sessionRows = [] } = {}) {
  const agentOf = r => r.agent ?? DEFAULT_AGENT;
  const models = [...new Set([...buckets.map(b => b.model), ...sessionRows.map(r => r.model)])].sort();
  const projects = [...new Set([...buckets.map(b => b.project ?? ""), ...time.projects.map(r => r.project), ...sessions.map(s => s.project)])].sort();
  const branches = [...new Set(sessionRows.map(r => r.branch))].sort();
  const agents = [...new Set([...buckets, ...time.projects, ...time.all, ...sessions, ...sessionRows].map(agentOf))].sort();
  const modelIndex = new Map(models.map((m, i) => [m, i]));
  const projectIndex = new Map(projects.map((p, i) => [p, i]));
  const branchIndex = new Map(branches.map((b, i) => [b, i]));
  const agentIndex = new Map(agents.map((a, i) => [a, i]));
  const sessionIndex = new Map(sessions.map((s, i) => [`${agentOf(s)}\t${s.id}`, i]));
  const data = {
    schema: SCHEMA,
    note: "Tokens and cost (USD, priced when first seen) per 15-minute UTC bucket, project (cwd relative to ~), model and agent (the AI tool), active seconds, and per session: title, branch, pull requests, cost. No prompts or message text. Written by ai-usage-cost.",
    updatedAt: now.toISOString(),
    agents,
    models,
    projects,
    branches,
    rows: buckets.map(b => [b.t, projectIndex.get(b.project ?? ""), modelIndex.get(b.model), b.input, b.output, b.cacheCreation, b.cacheRead, b.cacheCreation1h || 0, agentIndex.get(agentOf(b)), b.cost ?? null]),
    timeProjects: time.projects.map(r => [r.t, projectIndex.get(r.project), r.seconds, agentIndex.get(agentOf(r))]),
    timeAll: time.all.map(r => [r.t, r.seconds, agentIndex.get(agentOf(r))]),
    sessions: sessions.map(s => [s.id, s.title, projectIndex.get(s.project), s.t0, s.t1, s.seconds, s.prs, agentIndex.get(agentOf(s))]),
    sessionRows: sessionRows.filter(r => sessionIndex.has(`${agentOf(r)}\t${r.session}`)).map(r => [sessionIndex.get(`${agentOf(r)}\t${r.session}`), branchIndex.get(r.branch), modelIndex.get(r.model), r.side, r.input, r.output, r.cacheCreation, r.cacheCreation1h || 0, r.cacheRead, r.thinking || 0, r.cost ?? null]),
  };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`); // one rolling backup of the previous good state
    try { chmodSync(`${path}.bak`, 0o600); } catch { /* a file system without modes (Windows, some network drives) */ }
  }
  // the ledger lists project paths, branches and session titles: owner-only (rename keeps the mode, so an older world-readable file is replaced by a private one)
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}
