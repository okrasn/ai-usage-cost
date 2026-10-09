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
        activeSeconds: 0,
        timeCost: 0, // cost of just those days that have a measured active time (the numerator of the rate)
        timeDays: 0, // days of this period that have a measured active time
        days: 0,
        models: new Map(),
      };
      groups.set(k, g);
    }
    for (const f of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens", "totalCost"]) {
      g[f] += r[f];
    }
    g.days += 1;
    if (typeof r.activeSeconds === "number") {
      g.activeSeconds += r.activeSeconds;
      g.timeCost += r.totalCost;
      g.timeDays += 1;
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

// Weekly rows are keyed by the first day of the week — but a week that crosses New Year is split in two, each part
// keyed by its own first day inside its year (2025-12-29 and 2026-01-01). That keeps every year's weekly total equal
// to its daily and monthly totals and gives the year filter no phantom year.
export function weekKeyWithinYear(date, firstDay) {
  const start = weekStartOf(date, firstDay);
  return start.slice(0, 4) === date.slice(0, 4) ? start : `${date.slice(0, 4)}-01-01`;
}

export function buildPeriods(daily, { weekStart = "auto", locale } = {}) {
  const firstDay = resolveWeekStart(weekStart, locale);
  return {
    daily,
    weekly: merge(daily, "week", d => weekKeyWithinYear(d, firstDay)),
    monthly: merge(daily, "month", d => d.slice(0, 7)),
    weekStartDay: DAY_NAMES[firstDay],
  };
}
