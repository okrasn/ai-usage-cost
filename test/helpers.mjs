// Synthetic ccusage rows — shapes mirror real output, numbers are made up.
export function classicRow(date, cost, models = { "claude-sonnet-5": 1 }) {
  const names = Object.keys(models);
  return {
    date,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 100,
    totalCost: cost,
    modelsUsed: names,
    modelBreakdowns: names.map(n => ({
      modelName: n,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      cost: cost * models[n],
    })),
  };
}

// ccusage >= 19 unified report: `period` instead of `date`, plus agent/metadata.
export function periodRow(date, cost, models) {
  const { date: _d, ...rest } = classicRow(date, cost, models);
  return { period: date, agent: "all", metadata: { agents: ["claude"] }, ...rest };
}

export const ok = stdout => ({ status: 0, stdout, stderr: "" });
export const fail = (stderr, status = 1) => ({ status, stdout: "", stderr });
