import { DEFAULT_AGENT, agentMeta } from "./agents/index.mjs";
import { EMPTY_TIME, loadHistory, mergeBuckets, mergeSessionRows, mergeSessions, mergeTime, saveHistory } from "./history.mjs";
import { bucketDate, bucketsToCells, bucketsToProjectCells } from "./logs.mjs";
import { normalizeDaily } from "./normalize.mjs";
import { cacheSavedOf, costOf, dailyFromCells, lookupPrice } from "./pricing.mjs";

export const SOURCES = ["auto", "logs", "ccusage"];

// active seconds per local day (all projects united) and per day × project, from the 15-minute buckets
function timePayload(time, idleMinutes, withProjects) {
  const days = new Map();
  for (const r of time.all) days.set(bucketDate(r.t), (days.get(bucketDate(r.t)) ?? 0) + r.seconds);
  const byProject = new Map();
  if (withProjects) {
    for (const r of time.projects) {
      const k = `${bucketDate(r.t)}\t${r.project}`;
      byProject.set(k, (byProject.get(k) ?? 0) + r.seconds);
    }
  }
  return {
    idleMinutes,
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)),
    projects: [...byProject.entries()].map(([k, seconds]) => [...k.split("\t"), seconds]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  };
}
// Sessions for the page: one entry per session with its cost rows [branch, model, subagent, input, output, cacheWrite,
// cacheRead, cacheWrite1h, thinking, cost, cacheSaved]. A session without any usage row has nothing to show.
function sessionsPayload(list, rows, table) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.session)) byId.set(r.session, []);
    byId.get(r.session).push(r);
  }
  return list.filter(s => byId.has(s.id)).map(s => ({
    id: s.id, title: s.title, project: s.project, t0: s.t0, t1: s.t1, seconds: s.seconds, prs: s.prs,
    rows: byId.get(s.id).map(r => {
      const price = lookupPrice(r.model, table);
      return [r.branch, r.model, r.side, r.input, r.output, r.cacheCreation, r.cacheRead, r.cacheCreation1h || 0, r.thinking || 0, r.cost ?? 0, price ? cacheSavedOf(r, price) : 0];
    }),
  }));
}
const unpricedModels = cells => [...new Set(cells.filter(c => c.unpriced).map(c => c.model))].sort();

// source: "logs"    – read the agents' transcripts ourselves (needs no ccusage)
//         "ccusage" – shell out to ccusage (Claude Code only)
//         "auto"    – logs (plus the history ledger) when there is any usage, otherwise ccusage
// agents: the AI tools to read — [{ id, label, capabilities, read() }], see lib/agents/claude.mjs for the contract. Every
//         agent is merged with its own part of the ledger; one that has neither usage now nor in the ledger is not shown.
// getPrices(opts) resolves the price table lazily (the ccusage source never touches the network for prices).
// history: { enabled, path, reset, now } — see history.mjs: the ledger keeps usage AND its cost as priced when first seen.
// Returns the first shown agent's data at the top level (daily, projects, time, sessions) plus `agents` (what the page lists)
// and `extra` (the same four things for every further agent, by id).
export async function loadDaily({ source = "auto", agents = [], fetchCcusage, getPrices, history = { enabled: false }, projects = { enabled: false }, time = { enabled: false }, sessions = { enabled: false, titles: true }, log = () => {} }) {
  if (source !== "ccusage") {
    if (!agents.length) throw new Error("no agents to read (check \"agents\" in config.json)");
    const reads = agents.map(agent => ({ agent, read: agent.read() }));
    const blank = status => ({ buckets: [], time: EMPTY_TIME, sessions: [], sessionRows: [], status });
    const ledger = !history.enabled ? blank("absent") : history.reset ? blank("ok") : loadHistory(history.path, log);
    const idOf = r => r.agent ?? DEFAULT_AGENT;
    const owned = (rows, id) => rows.filter(r => idOf(r) === id);
    const tag = (rows, id) => (rows ?? []).map(r => ({ ...r, agent: id }));

    // an agent is shown when the logs hold usage now or the ledger remembers some
    const work = reads
      .filter(({ agent, read }) => (read.buckets?.length ?? 0) > 0 || owned(ledger.buckets, agent.id).length > 0)
      .map(({ agent, read }) => {
        const id = agent.id;
        const sessionsOn = sessions.enabled && agent.capabilities.sessions;
        return {
          agent, read,
          sessionsOn,
          fresh: tag(read.buckets, id),
          freshRows: sessionsOn ? tag(read.sessionRows, id) : [],
          freshSessions: sessionsOn ? tag(read.sessions, id) : [],
          freshTime: agent.capabilities.time && read.time ? { projects: tag(read.time.projects, id), all: tag(read.time.all, id) } : EMPTY_TIME,
          own: { buckets: owned(ledger.buckets, id), time: { projects: owned(ledger.time.projects, id), all: owned(ledger.time.all, id) }, sessions: owned(ledger.sessions, id), sessionRows: owned(ledger.sessionRows, id) },
        };
      });

    if (work.length) {
      // Buckets that are new (or grew) are priced with today's table; buckets already in the ledger keep their recorded cost.
      const assemble = prices => work.map(w => {
        const priceFor = model => lookupPrice(model, prices.table);
        if (history.enabled) {
          const b = mergeBuckets(w.own.buckets, w.fresh, priceFor);
          const r = w.sessionsOn ? mergeSessionRows(w.own.sessionRows, w.freshRows, priceFor) : { rows: w.own.sessionRows, changed: false };
          return { buckets: b.buckets, sessionRows: r.rows, changed: b.changed || r.changed };
        }
        const priced = rows => rows.map(r => ({ ...r, cost: priceFor(r.model) ? costOf(r, priceFor(r.model)) : null }));
        return { changed: false, buckets: priced(w.fresh), sessionRows: priced(w.freshRows) };
      });
      const cellsOf = merged => merged.map(m => bucketsToCells(m.buckets));
      let prices = await getPrices();
      let merged = assemble(prices);
      let cells = cellsOf(merged);
      if (cells.some(c => unpricedModels(c).length)) {
        // a model we have no price for may have been added upstream since the last download — try once more
        const again = await getPrices({ wantFresh: true });
        if (again.origin === "refreshed") {
          prices = again;
          merged = assemble(prices);
          cells = cellsOf(merged);
        }
      }

      // active time merges like the tokens (per-field maximum); with the ledger off it is just what the logs show now
      const times = work.map(w => (history.enabled ? mergeTime(w.own.time, w.freshTime) : { time: w.freshTime, changed: false }));
      // session metadata (titles, span, pull requests); with "sessionTitles": "off" no title is kept, not even one recorded earlier
      const metas = work.map(w => (history.enabled && w.sessionsOn ? mergeSessions(w.own.sessions, w.freshSessions) : { sessions: history.enabled ? w.own.sessions : w.freshSessions, changed: false }));
      const titlesDropped = !sessions.titles && metas.some(m => m.sessions.some(x => x.title));
      const sessionLists = metas.map(m => (sessions.titles ? m.sessions : m.sessions.map(x => ({ ...x, title: "" }))));
      const changed = merged.some(m => m.changed) || times.some(t => t.changed) || metas.some(m => m.changed) || titlesDropped || history.reset;
      if (history.enabled && changed && ledger.status !== "newer") {
        // what the ledger holds for agents that are not part of this run stays exactly as it is
        const shown = new Set(work.map(w => w.agent.id));
        const rest = rows => rows.filter(r => !shown.has(idOf(r)));
        saveHistory(history.path, [...merged.flatMap(m => m.buckets), ...rest(ledger.buckets)], history.now,
          { projects: [...times.flatMap(t => t.time.projects), ...rest(ledger.time.projects)], all: [...times.flatMap(t => t.time.all), ...rest(ledger.time.all)] },
          { sessions: [...sessionLists.flat(), ...rest(ledger.sessions)], sessionRows: [...merged.flatMap(m => m.sessionRows), ...rest(ledger.sessionRows)] });
      }

      const results = work.map((w, i) => {
        const caps = w.agent.capabilities;
        const { daily, unpriced } = dailyFromCells(cells[i], prices.table);
        return {
          id: w.agent.id,
          unpriced,
          daily,
          // day × project × model rows for the whole history (Today and Projects tabs); null when project names are switched off
          projects: projects.enabled && caps.projects ? bucketsToProjectCells(merged[i].buckets).map(r => { const price = lookupPrice(r.model, prices.table); return price ? { ...r, saved: cacheSavedOf(r, price) } : r; }) : null,
          time: time.enabled && caps.time ? timePayload(times[i].time, time.idleMinutes, projects.enabled && caps.projects) : null,
          sessions: sessions.enabled && caps.sessions ? sessionsPayload(sessionLists[i], merged[i].sessionRows, prices.table) : null,
        };
      });

      let historyInfo = null;
      if (history.enabled) {
        const inLogs = new Set(work.flatMap(w => w.read.cells ?? []).map(c => c.date));
        const days = [...new Set(cells.flat().map(c => c.date))].sort();
        historyInfo = { days: days.length, first: days[0] ?? null, restoredDays: days.filter(d => !inLogs.has(d)).length };
      }
      for (const w of work) {
        const stats = w.read.stats;
        if (!stats) continue;
        const dup = stats.duplicates ? `, ${stats.duplicates.toLocaleString("en-US")} duplicate streaming entries ignored` : "";
        log(`Data source: ${w.agent.label} logs (${stats.files} files, ${stats.records.toLocaleString("en-US")} usage records${dup})`);
      }
      if (historyInfo) log(`History: ${historyInfo.days} days kept in history.json (since ${historyInfo.first})${historyInfo.restoredDays ? `, ${historyInfo.restoredDays} of them no longer in the logs` : ""}.`);
      const { asOf, origin, ageDays, refreshFailed } = prices;
      const [first, ...others] = results;
      return {
        daily: first.daily, unpriced: [...new Set(results.flatMap(r => r.unpriced))].sort(), source: "logs", prices: { asOf, origin, ageDays, refreshFailed }, history: historyInfo,
        projects: first.projects, time: first.time, sessions: first.sessions,
        agents: work.map(w => agentMeta(w.agent)),
        extra: Object.fromEntries(others.map(r => [r.id, { daily: r.daily, projects: r.projects, time: r.time, sessions: r.sessions }])),
      };
    }
    if (source === "logs") {
      const stats = reads[0].read.stats ?? { roots: [] };
      throw new Error(
        stats.roots.length
          ? `no usage records found under ${stats.roots.join(", ")}`
          : "no Claude Code log directory found (looked for $CLAUDE_CONFIG_DIR, ~/.config/claude/projects, ~/.claude/projects)"
      );
    }
    log("No local usage records found — falling back to ccusage.");
  }
  log("Data source: ccusage");
  const claude = agents.find(a => a.id === DEFAULT_AGENT) ?? agents[0];
  // ccusage reports totals per day and model, nothing else
  const meta = claude ? agentMeta({ ...claude, capabilities: { cache: true, time: false, projects: false, sessions: false, subagents: false, thinking: false } }) : { id: DEFAULT_AGENT, label: "Claude Code", capabilities: {} };
  return { daily: normalizeDaily(fetchCcusage()), unpriced: [], source: "ccusage", prices: null, history: null, projects: null, time: null, sessions: null, agents: [meta], extra: {} };
}
