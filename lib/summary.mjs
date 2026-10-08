const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const usd = x => `$${x.toFixed(2)}`;
const int = x => x.toLocaleString("en-US");
const shortModel = m => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");

function sum(rows) {
  return rows.reduce(
    (acc, r) => ({ cost: acc.cost + r.totalCost, tokens: acc.tokens + r.totalTokens }),
    { cost: 0, tokens: 0 }
  );
}

export function buildSummary(daily, now = new Date(), { unpriced = [], prices = null } = {}) {
  const today = ymd(now);
  const thisMonth = today.slice(0, 7);
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6); // today + previous 6 days
  const cutoff = ymd(weekAgo);

  const t = sum(daily.filter(r => r.date === today));
  const w = sum(daily.filter(r => r.date >= cutoff));
  const m = sum(daily.filter(r => r.date.startsWith(thisMonth)));
  const all = sum(daily);

  const modelCost = new Map();
  for (const r of daily) {
    for (const b of r.modelBreakdowns) modelCost.set(b.modelName, (modelCost.get(b.modelName) ?? 0) + b.cost);
  }
  const top = [...modelCost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const lines = [
    "",
    "## Claude Usage — quick summary",
    "",
    "| Period | Cost | Tokens |",
    "|---|---:|---:|",
    `| Today (${today}) | ${usd(t.cost)} | ${int(t.tokens)} |`,
    `| Last 7 days | ${usd(w.cost)} | ${int(w.tokens)} |`,
    `| This month (${thisMonth}) | ${usd(m.cost)} | ${int(m.tokens)} |`,
    `| All time | ${usd(all.cost)} | ${int(all.tokens)} |`,
    "",
  ];
  if (top.length) {
    lines.push("### Top models by cost (all time)", "", "| Model | Cost |", "|---|---:|");
    for (const [name, cost] of top) lines.push(`| ${shortModel(name)} | ${usd(cost)} |`);
    lines.push("");
  }
  if (unpriced.length) {
    lines.push(`> ⚠️ No price for ${unpriced.length} model(s): ${unpriced.join(", ")} — their cost is counted as $0. Add rates under "prices" in config.json or update the package.`, "");
  }
  if (prices && prices.asOf && (prices.origin !== "refreshed" && prices.asOf !== today)) {
    const why = prices.refreshFailed ? "could not be refreshed" : prices.origin === "bundled" ? "bundled with the package" : "not refreshed today";
    lines.push(`> ℹ️ Prices as of ${prices.asOf} (${why}).`, "");
  }
  return lines.join("\n");
}
