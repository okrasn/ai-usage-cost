import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pad = n => String(n).padStart(2, "0");
const QUARTER = 15 * 60 * 1000;
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

// Reads assistant `message.usage` records. Claude Code writes several entries per API response while it streams
// (same message.id + requestId, growing output_tokens): keep the one with the largest output — the final usage.
export function readLogs({ roots = logRoots() } = {}) {
  const keyed = new Map();
  const unkeyed = [];
  let files = 0;
  let duplicates = 0;
  for (const root of roots) {
    for (const file of jsonlFiles(root)) {
      files++;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes('"usage"')) continue; // cheap pre-filter: most lines are prompts/attachments
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
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
    }
  }
  const buckets = new Map();
  for (const r of [...keyed.values(), ...unkeyed]) {
    const k = `${r.t}\t${r.model}`;
    const b = buckets.get(k) ?? { t: r.t, model: r.model, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
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
    stats: { roots, files, records: keyed.size + unkeyed.length, duplicates },
  };
}
