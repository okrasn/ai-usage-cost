const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function normalizeBreakdown(b) {
  return {
    modelName: String(b.modelName ?? "unknown"),
    cost: num(b.cost),
    inputTokens: num(b.inputTokens),
    outputTokens: num(b.outputTokens),
    cacheCreationTokens: num(b.cacheCreationTokens),
    cacheReadTokens: num(b.cacheReadTokens),
  };
}

function normalizeRow(r, i) {
  // ccusage 19+/unified reports name the day `period`; classic reports use `date`
  const date = r.date ?? r.period;
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    throw new Error(`unexpected ccusage output: daily row ${i} has no YYYY-MM-DD "date"/"period"`);
  }
  const breakdowns = (Array.isArray(r.modelBreakdowns) ? r.modelBreakdowns : []).map(normalizeBreakdown);
  const row = {
    date,
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheCreationTokens: num(r.cacheCreationTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    totalCost: num(r.totalCost),
    modelsUsed: Array.isArray(r.modelsUsed) ? r.modelsUsed.map(String) : breakdowns.map(b => b.modelName),
    modelBreakdowns: breakdowns,
  };
  row.totalTokens = typeof r.totalTokens === "number"
    ? r.totalTokens
    : row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
  return row;
}

export function normalizeDaily(json) {
  if (!json || !Array.isArray(json.daily)) {
    throw new Error('unexpected ccusage output: no "daily" array (is ccusage >= 12.4.0?)');
  }
  return json.daily.map(normalizeRow).sort((a, b) => a.date.localeCompare(b.date));
}
