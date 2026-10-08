import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LITELLM_URL, assertSaneTable, fromLiteLLM } from "./price-table.mjs";

export const SCHEMA = 1;
export const RETRY_MS = 60 * 60 * 1000; // after a failed refresh, and before re-trying because a model is unpriced
const DAY_MS = 86400000;

const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// bundled snapshot dates are plain dates; the cache stores timestamps
const asOf = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : ymd(new Date(v)));
const dayNumber = s => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY_MS);

function readJson(path) {
  try {
    return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null; // a corrupt file is treated as absent and gets overwritten by the next refresh
  }
}
const asSnapshot = o => (o && typeof o.models === "object" && o.models && o.fetchedAt ? o : null);

function writeCache(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export async function fetchModels({ url = LITELLM_URL, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const models = fromLiteLLM(await res.json());
  assertSaneTable(models);
  return models;
}

// Picks the freshest prices available without ever failing because of the network:
//   refreshed (just downloaded) > cache (downloaded earlier, prices-cache.json) > bundled (vendor/prices.json).
// mode "daily": download on the first run of each local day; "off": never download unless `force`.
// After a failed download the cache remembers it and the next attempt waits RETRY_MS (an offline machine must not
// stall every run). `wantFresh` asks for an extra attempt (a model without a price was found) once RETRY_MS has passed.
export async function resolvePrices({ bundledPath, cachePath, overrides = {}, mode = "daily", force = false, wantFresh = false, now = new Date(), url, fetchImpl, log = () => {} }) {
  const bundled = asSnapshot(readJson(bundledPath));
  let cache = readJson(cachePath);
  if (cache?.schema !== SCHEMA) cache = null;

  const today = ymd(now);
  const lastGood = asSnapshot(cache);
  const lastFailedAt = cache?.lastFailedAt ? Date.parse(cache.lastFailedAt) : null;
  const backingOff = lastFailedAt !== null && now - lastFailedAt < RETRY_MS;
  const due = !lastGood || asOf(lastGood.fetchedAt) !== today;
  const retryUnpriced = wantFresh && (!lastGood || now - Date.parse(lastGood.fetchedAt) >= RETRY_MS);
  const attempt = force || (mode === "daily" && !backingOff && (due || retryUnpriced));

  let origin = null;
  let error = null;
  if (attempt) {
    try {
      const models = await fetchModels({ url, fetchImpl });
      cache = { schema: SCHEMA, source: url ?? LITELLM_URL, fetchedAt: now.toISOString(), models };
      origin = "refreshed";
      log(`Prices refreshed (${Object.keys(models).length} Claude models).`);
    } catch (e) {
      error = e.message;
      cache = { ...(cache ?? { schema: SCHEMA }), lastFailedAt: now.toISOString() };
    }
    try {
      writeCache(cachePath, cache);
    } catch (e) {
      log(`Could not save the price cache (${e.message}).`);
    }
  }

  const snaps = [bundled, asSnapshot(cache)].filter(Boolean).sort((a, b) => asOf(a.fetchedAt).localeCompare(asOf(b.fetchedAt)));
  const newest = snaps.at(-1);
  const models = Object.assign({}, ...snaps.map(s => s.models), overrides);
  const date = newest ? asOf(newest.fetchedAt) : null;
  if (!origin) origin = newest && newest === asSnapshot(cache) ? "cache" : "bundled";
  if (error) log(`Could not refresh prices (${error}) — using prices as of ${date ?? "n/a"}.`);

  return {
    table: { models },
    asOf: date,
    origin,
    ageDays: date ? dayNumber(today) - dayNumber(date) : null,
    // a failed attempt, or a skipped one because the previous attempt failed less than RETRY_MS ago while today's download is still missing
    refreshFailed: Boolean(error) || (backingOff && due),
  };
}
