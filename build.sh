#!/usr/bin/env bash
set -euo pipefail

DIR="${HOME}/.claude/dashboard"
OUT="${DIR}/index.html"
TEMPLATE="${DIR}/template.html"

NO_OPEN=0
NO_SUMMARY=0
for arg in "$@"; do
  case "$arg" in
    --no-open)    NO_OPEN=1 ;;
    --no-summary) NO_SUMMARY=1 ;;
  esac
done

export DAILY=$(npx --yes ccusage daily --json --breakdown)
export WEEKLY=$(npx --yes ccusage weekly --json --breakdown)
export MONTHLY=$(npx --yes ccusage monthly --json --breakdown)
export GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if command -v claude >/dev/null 2>&1; then
  export USER_NAME=$(claude auth status --json 2>/dev/null \
    | python3 -c 'import json, sys; d=json.load(sys.stdin); e=d.get("email","").split("@")[0]; print(e[:1].upper()+e[1:] if e else "User")' 2>/dev/null \
    || echo "User")
else
  export USER_NAME="User"
fi

python3 - "$TEMPLATE" "$OUT" <<'PY' >/dev/null
import json, sys, os
template_path, out_path = sys.argv[1], sys.argv[2]
d = json.loads(os.environ["DAILY"])
w = json.loads(os.environ["WEEKLY"])
m = json.loads(os.environ["MONTHLY"])
payload = {
    "daily":   d.get("daily", []),
    "weekly":  w.get("weekly", []),
    "monthly": m.get("monthly", []),
    "totals":  m.get("totals", {}),
    "generatedAt": os.environ["GENERATED_AT"],
}
with open(template_path, "r", encoding="utf-8") as f:
    html = f.read()
html = html.replace("__DATA__", json.dumps(payload))
html = html.replace("__USER_NAME__", os.environ.get("USER_NAME", "User"))
with open(out_path, "w", encoding="utf-8") as f:
    f.write(html)
PY

if [[ "$NO_SUMMARY" -eq 0 ]]; then
python3 - <<'PY'
import json, os, re
from datetime import datetime, timedelta

daily   = json.loads(os.environ["DAILY"]).get("daily", [])
monthly = json.loads(os.environ["MONTHLY"]).get("monthly", [])

now = datetime.now()
today_str = now.strftime("%Y-%m-%d")
this_month = now.strftime("%Y-%m")
cutoff_7d = (now - timedelta(days=7)).strftime("%Y-%m-%d")

today_row = next((r for r in daily if r["date"] == today_str), None)
month_row = next((r for r in monthly if r["month"] == this_month), None)
last7 = [r for r in daily if r["date"] >= cutoff_7d]
sum_cost_7d   = sum(r["totalCost"]   for r in last7)
sum_tokens_7d = sum(r["totalTokens"] for r in last7)
all_cost   = sum(r["totalCost"]   for r in monthly)
all_tokens = sum(r["totalTokens"] for r in monthly)

model_costs = {}
for r in monthly:
    for b in r.get("modelBreakdowns", []):
        model_costs[b["modelName"]] = model_costs.get(b["modelName"], 0) + b["cost"]
top_models = sorted(model_costs.items(), key=lambda x: -x[1])[:5]

def fmt_usd(x): return f"${x:.2f}"
def fmt_n(x):   return f"{x:,}"
def short(m):   return re.sub(r"-\d{8}$", "", m.replace("claude-", ""))

print()
print("## OK Claude Usage — quick summary")
print()
print("| Period | Cost | Tokens |")
print("|---|---:|---:|")
if today_row:
    print(f"| Today ({today_str}) | {fmt_usd(today_row['totalCost'])} | {fmt_n(today_row['totalTokens'])} |")
else:
    print(f"| Today ({today_str}) | $0.00 | 0 |")
print(f"| Last 7 days | {fmt_usd(sum_cost_7d)} | {fmt_n(sum_tokens_7d)} |")
if month_row:
    print(f"| This month ({this_month}) | {fmt_usd(month_row['totalCost'])} | {fmt_n(month_row['totalTokens'])} |")
else:
    print(f"| This month ({this_month}) | $0.00 | 0 |")
print(f"| All time | {fmt_usd(all_cost)} | {fmt_n(all_tokens)} |")
print()
if top_models:
    print("### Top models by cost (all time)")
    print()
    print("| Model | Cost |")
    print("|---|---:|")
    for m, c in top_models:
        print(f"| {short(m)} | {fmt_usd(c)} |")
    print()
PY
fi

echo "Dashboard regenerated: ${OUT}"

if [[ "${TERM_PROGRAM:-}" == "vscode" ]]; then
  echo ""
  echo "Inside VS Code? Open in Simple Browser instead of a separate window:"
  echo "  Cmd+Shift+P → 'Simple Browser: Show' → file://${OUT}"
fi

if [[ "$NO_OPEN" -eq 0 ]]; then
  open "$OUT"
fi
