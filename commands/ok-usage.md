---
description: Rebuild the Claude Usage Dashboard, show inline summary, and open it in the browser
allowed-tools: Bash(bash:*)
---

!bash ~/.claude/dashboard/build.sh

The bash output above contains a markdown summary of recent Claude Code usage (Today, Last 7 days, This month, All time, plus top models by cost). Render that summary verbatim as your reply, preserving the markdown tables exactly so they display properly in the chat. Then on a final line, briefly confirm the full visual dashboard was opened in the browser. If the output also includes the "Simple Browser" tip (when running inside a VS Code terminal), include that line at the very end so the user can click it.
