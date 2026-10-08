const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MS_PER_DAY = 86400000;

export const WEEK_START_VALUES = ["auto", ...DAY_NAMES];

// 0 = Sunday … 6 = Saturday (matches Date#getUTCDay).
export function localeFirstDay(locale) {
  try {
    const l = new Intl.Locale(locale ?? Intl.DateTimeFormat().resolvedOptions().locale);
    const info = typeof l.getWeekInfo === "function" ? l.getWeekInfo() : l.weekInfo;
    // Intl numbers days 1 = Monday … 7 = Sunday
    if (info && Number.isInteger(info.firstDay)) return info.firstDay % 7;
  } catch {
    // fall through to the ISO default
  }
  return 1; // Monday (ISO 8601) when the runtime exposes no week data
}

export function resolveWeekStart(setting = "auto", locale) {
  const name = String(setting).toLowerCase();
  const idx = DAY_NAMES.indexOf(name);
  return idx !== -1 ? idx : localeFirstDay(locale);
}

const parseUtc = date => new Date(`${date}T00:00:00Z`);
const fmtUtc = d => d.toISOString().slice(0, 10);

export function weekStartOf(date, firstDay) {
  const d = parseUtc(date);
  const back = (d.getUTCDay() - firstDay + 7) % 7;
  return fmtUtc(new Date(d.getTime() - back * MS_PER_DAY));
}

function merge(rows, keyName, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r.date);
    let g = groups.get(k);
    if (!g) {
      g = {
        [keyName]: k,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        models: new Map(),
      };
      groups.set(k, g);
    }
    for (const f of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "totalCost"]) {
      g[f] += r[f];
    }
    for (const m of r.modelsUsed) if (!g.models.has(m)) g.models.set(m, null);
    for (const b of r.modelBreakdowns) {
      const cur = g.models.get(b.modelName) ?? {
        modelName: b.modelName,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      for (const f of ["cost", "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]) cur[f] += b[f];
      g.models.set(b.modelName, cur);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a[keyName].localeCompare(b[keyName]))
    .map(({ models, ...row }) => ({
      ...row,
      modelsUsed: [...models.keys()],
      modelBreakdowns: [...models.values()].filter(Boolean),
    }));
}

export function buildPeriods(daily, { weekStart = "auto", locale } = {}) {
  const firstDay = resolveWeekStart(weekStart, locale);
  return {
    daily,
    weekly: merge(daily, "week", d => weekStartOf(d, firstDay)),
    monthly: merge(daily, "month", d => d.slice(0, 7)),
    weekStartDay: DAY_NAMES[firstDay],
  };
}
