import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pad = n => String(n).padStart(2, "0");
const QUARTER = 15 * 60 * 1000;

// Where the message was written from (the `cwd` of the record), shown relative to the home directory: "~/ok/app".
// "" = unknown. The path only ever lands in history.json and the generated page — never prompts or file contents.
export function projectOf(cwd, home = homedir()) {
  if (typeof cwd !== "string" || !cwd) return "";
  const c = cwd.length > 1 ? cwd.replace(/[\\/]+$/, "") : cwd;
  return home && (c === home || c.startsWith(`${home}/`) || c.startsWith(`${home}\\`)) ? `~${c.slice(home.length)}` : c;
}
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Directories holding Claude Code transcripts: $CLAUDE_CONFIG_DIR (comma-separated) or the two default locations.
export function logRoots({ env = process.env, home = homedir() } = {}) {
  const bases = env.CLAUDE_CONFIG_DIR
    ? env.CLAUDE_CONFIG_DIR.split(",").map(s => s.trim()).filter(Boolean)
    : [join(env.XDG_CONFIG_HOME || join(home, ".config"), "claude"), join(home, ".claude")];
  const seen = new Set();
  const roots = [];
  for (const base of bases) {
    const dir = join(base, "projects");
    if (!existsSync(dir)) continue;
    const real = realpathSync(dir);
    if (!seen.has(real)) {
      seen.add(real);
      roots.push(dir);
    }
  }
  return roots;
}

function jsonlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? jsonlFiles(p) : e.isFile() && e.name.endsWith(".jsonl") ? [p] : [];
  });
}

// 15-minute UTC buckets → one cell per local calendar day and model (the shape the dashboard prices and shows).
export function bucketsToCells(buckets) {
  const cells = new Map();
  for (const b of buckets) {
    const date = localDate(new Date(b.t * QUARTER));
    const k = `${date}\t${b.model}`;
    const c = cells.get(k) ?? { date, model: b.model, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    c.input += b.input;
    c.output += b.output;
    c.cacheCreation += b.cacheCreation;
    c.cacheRead += b.cacheRead;
    if (b.cost !== undefined) {           // buckets that carry a recorded cost (null = no price known yet)
      c.cost = (c.cost ?? 0) + (b.cost ?? 0);
      if (b.cost === null) c.unpriced = true;
    }
    cells.set(k, c);
  }
  return [...cells.values()];
}

// Same buckets, one row per local day × project × model (what the Today tab breaks down). `sinceDate` (YYYY-MM-DD) trims.
export function bucketsToProjectCells(buckets, sinceDate = "") {
  const cells = new Map();
  for (const b of buckets) {
    const date = localDate(new Date(b.t * QUARTER));
    if (date < sinceDate) continue;
    const project = b.project ?? "";
    const k = `${date}\t${project}\t${b.model}`;
    const c = cells.get(k) ?? { date, project, model: b.model, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, cost: 0 };
    c.input += b.input;
    c.output += b.output;
    c.cacheCreation += b.cacheCreation;
    c.cacheRead += b.cacheRead;
    c.cost += b.cost ?? 0; // null = no price known: counts as 0 here, and the model is reported as unpriced elsewhere
    cells.set(k, c);
  }
  return [...cells.values()].sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project) || a.model.localeCompare(b.model));
}

const mergeIntervals = list => {
  const out = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
};
function addSeconds(map, t, project, seconds) {
  const k = `${t}\t${project}`;
  const row = map.get(k) ?? { t, project, seconds: 0 };
  row.seconds += seconds;
  map.set(k, row);
}
const splitByBucket = (intervals, add) => {
  for (const [a, b] of intervals) {
    for (let t = Math.floor(a / QUARTER); t * QUARTER < b; t++) add(t, Math.min(b, (t + 1) * QUARTER) - Math.max(a, t * QUARTER));
  }
};

// Active time: in every session (transcript file) the gaps between consecutive events that are at most `idleMinutes`
// long count as work, longer gaps count as being away. A gap belongs to the project the session was in when it began.
// Intervals are united per project (parallel sessions in one folder count once) and, separately, over all projects
// (the day's real total). Result: seconds per 15-minute UTC bucket, so it merges into the history ledger like tokens.
export function activeTime(sessions, idleMinutes = 10) {
  const idle = idleMinutes * 60000;
  const byProject = new Map();
  const all = [];
  for (const events of sessions) {
    const sorted = [...events].sort((a, b) => a.ms - b.ms);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (b.ms > a.ms && b.ms - a.ms <= idle) {
        if (!byProject.has(a.project)) byProject.set(a.project, []);
        byProject.get(a.project).push([a.ms, b.ms]);
        all.push([a.ms, b.ms]);
      }
    }
  }
  const projectsOut = new Map();
  for (const [project, ivs] of byProject) splitByBucket(mergeIntervals(ivs), (t, ms) => addSeconds(projectsOut, t, project, ms / 1000));
  const allOut = new Map();
  splitByBucket(mergeIntervals(all), (t, ms) => addSeconds(allOut, t, "", ms / 1000));
  const round = r => ({ ...r, seconds: Math.round(r.seconds) });
  return {
    projects: [...projectsOut.values()].map(round).filter(r => r.seconds > 0),
    all: [...allOut.values()].map(({ t, seconds }) => ({ t, seconds: Math.round(seconds) })).filter(r => r.seconds > 0),
  };
}

// local calendar date of a 15-minute bucket (a bucket never straddles local midnight)
export const bucketDate = t => localDate(new Date(t * QUARTER));

// Reads assistant `message.usage` records. Claude Code writes several entries per API response while it streams
// (same message.id + requestId, growing output_tokens): keep the one with the largest output — the final usage.
export function readLogs({ roots = logRoots(), projects = true, home = homedir(), time = true, idleMinutes = 10 } = {}) {
  const keyed = new Map();
  const unkeyed = [];
  const sessions = []; // per transcript file: every timestamped event with the project it happened in (for active time)
  let files = 0;
  let duplicates = 0;
  for (const root of roots) {
    for (const file of jsonlFiles(root)) {
      files++;
      const events = [];
      let cwd = "";
      for (const line of readFileSync(file, "utf8").split("\n")) {
        // without active time only the lines that can hold token usage matter (most lines are prompts/attachments)
        if (!line || (!time && !line.includes('"usage"'))) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof o?.cwd === "string" && o.cwd) cwd = o.cwd; // the folder keeps applying to the lines that do not repeat it
        if (time) {
          const ms = Date.parse(o?.timestamp);
          if (Number.isFinite(ms)) events.push({ ms, project: projects ? projectOf(cwd, home) : "" });
        }
        const m = o?.message;
        const u = m?.usage;
        if (!m || typeof m !== "object" || !u || typeof u !== "object") continue;
        const model = typeof m.model === "string" && m.model ? m.model : "unknown";
        if (model === "<synthetic>") continue;
        const at = new Date(o.timestamp);
        if (Number.isNaN(at.getTime())) continue;
        const rec = {
          t: Math.floor(at.getTime() / QUARTER), // 15-minute UTC bucket: every real time-zone offset is a multiple of it
          project: projects ? projectOf(o.cwd, home) : "",
          model,
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheCreation: num(u.cache_creation_input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
        };
        if (m.id && o.requestId) {
          const key = `${m.id}:${o.requestId}`;
          const prev = keyed.get(key);
          if (prev) duplicates++;
          if (!prev || rec.output > prev.output) keyed.set(key, rec);
        } else {
          unkeyed.push(rec);
        }
      }
      if (events.length) sessions.push(events);
    }
  }
  const buckets = new Map();
  for (const r of [...keyed.values(), ...unkeyed]) {
    const k = `${r.t}\t${r.project}\t${r.model}`;
    const b = buckets.get(k) ?? { t: r.t, project: r.project, model: r.model, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    b.input += r.input;
    b.output += r.output;
    b.cacheCreation += r.cacheCreation;
    b.cacheRead += r.cacheRead;
    buckets.set(k, b);
  }
  const list = [...buckets.values()];
  return {
    buckets: list,
    cells: bucketsToCells(list),
    time: time ? activeTime(sessions, idleMinutes) : null,
    stats: { roots, files, records: keyed.size + unkeyed.length, duplicates },
  };
}
