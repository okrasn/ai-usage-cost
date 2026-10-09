# Changelog

All notable changes to **ai-usage-cost** (until 1.2.0 published as `ccusage-ui-dashboard`). Newest first.

## v1.3.0

**Renamed:** the package, repository and command are now **`ai-usage-cost`** (was `ccusage-ui-dashboard`) — the name no longer promises a ccusage front-end, which this has not been since the built-in log reader, and leaves room for other agents later. Install with `npx ai-usage-cost`; an existing `~/.claude/dashboard` upgrades in place. The environment variable for the skill prefix is now **`AI_USAGE_PREFIX`** (was `CC_USAGE_PREFIX`, which still works as a fallback; `AI_USAGE_PREFIX` wins when both are set).

Two changes: `/<prefix>-usage` is now a **skill**, and the dashboard reads your Claude Code logs itself instead of depending on ccusage. How you call it does not change.

**Changed — the default command is `/ai-usage`**
- The default skill prefix is now **`ai`** (it was `my`), so a fresh install gives `/ai-usage`; the README examples use it too. A prefix already installed by this package is still offered first, so an upgrade keeps the command you type (`/ok-usage` stays `/ok-usage`). `AI_USAGE_PREFIX=<name>` or `--prefix <name>` picks another.
- The chat summary is headed with the tool it is about (`## Claude Code usage — quick summary`; it said "Claude Usage").

**Changed — private files**
- `history.json` (and its `.bak`) and the generated `index.html` are now written owner-only (`0600`). They list project paths, branches and session titles; before, they got the default mode (world-readable on many systems). An existing file is replaced by a private one on the next run, and `--doctor` has nothing to warn about on a fresh install.

**Verified for this release**
- The whole test suite passes on Node 18.20, 20.20, 22.14 and 24.21 (macOS); a real build and `--doctor` ran on Node 18 against real logs. The reader still matches ccusage 20.0.26 on all 42 (day, model) cells of the maintainer's logs (tokens exact, cost within 1e-6; ccusage 18 differs in output tokens, as documented). The bundled price table is current (22 models, nothing new). Windows and Linux are covered only by the new CI workflow (`.github/workflows/ci.yml`), which has not run yet.

**Added — printing**
- A **print** button next to the theme toggle (and Ctrl/Cmd+P) prints the active tab: a white A4 landscape page whatever the theme (the charts are redrawn in the light palette and without animation just before printing, then put back; your saved theme is not touched), no tabs, year / period controls or buttons, the tab and its period written under the heading (they were only in the controls), a running header (`Claude Code AI Usage Dashboard · Sessions · last 30 days`) and a footer (`npmjs.com/package/ai-usage-cost · v1.3.0` — the address is spelled out so that whoever reads a printout can install the package — and `page / pages`) on every page, the table header repeated on every page, rows never cut in two, the figures block and the charts kept whole. Adapted from the print skeleton of the author's maths-pack UI. Running header / footer / page numbers need `@page` margin boxes (Chrome / Edge 131+); other browsers print the content without them. Verified by printing the Today, Daily, Projects and Sessions tabs of real data to PDF in Chrome (headless Chrome 155) and reading the pages.
- The footer line of the page now says "AI Usage Dashboard" and "Data: local logs of your AI tools" (it still said Claude).

**Added — groundwork for more AI tools (agents)**
- The dashboard now has a notion of an *agent* — one AI tool whose logs it reads (`lib/agents/`: a contract with `id`, `label`, `capabilities`, `detect()` and `read()`, plus a registry). Claude Code is the only agent this version ships; nothing about how it looks or what it shows has changed, except the heading below.
- The heading reads **"<tool> AI Usage Dashboard"** ("Claude Code AI Usage Dashboard"), the page title and the line under it name the tool too. When more than one tool has data, a drop-down next to the theme toggle switches the whole page to another tool (its own years, tabs, Time / Rate, privacy button; a tab the tool cannot fill is hidden, a switch from such a tab lands on Today). With one tool the drop-down is hidden.
- **Your name is no longer in the heading**, and the dashboard no longer runs `claude auth status` on every build to find it (that also put your e-mail's local part into the page, which privacy mode did not mask).
- New option `agents` in `config.json` (`"auto"` or a list of ids) and a line in `--doctor` that says which tools were found.
- `history.json` is now **schema 5**: every row carries the agent (buckets, active time, sessions). Older files (schema 1–4) are read as agent `claude` and upgraded on the first run; recorded costs, tokens and titles are untouched (verified on the maintainer's ledger: no bucket lost or shrunk). Each agent is merged on its own, and the history of an agent that is not part of a run (switched off in `agents`, its tool uninstalled) stays in the file.
- **Not included:** a reader for any other tool. None can be built honestly without real logs of that tool, and none of Gemini CLI / Codex / Cursor / OpenCode existed on the maintainer's machine; the framework is tested with an invented second tool. See "Adding another AI tool" in the README.

**Added — Sessions tab**
- New **Sessions** tab (hidden when there is no session data): one row per Claude Code session with its title (the one Claude Code generated, or the one you gave it yourself), cost, tokens, active time, `$/h`, models and last activity, and a grey line under the title with the git branch it worked on (when a branch was checked out; `HEAD` is not a branch) and how many pull requests Claude Code linked to it — the full list is in the hover. The same period chips as on Projects (1d … All) apply; a session belongs to the period of its last message and counts with its whole cost. The table lists the most recently active session first (the chart shows the most expensive ones). Cards (Min / Avg / Max per session), the average line, a chart of the 12 biggest sessions (no summed "+N more" bar: with dozens of sessions it would tower over every real one) and the model doughnut belong to it.
- There is deliberately **no Session / Branch / PR switch**: when every task is a new session with its own branch and pull request they are the same rows under three names (on the maintainer's data 52 of 54 sessions had exactly one branch), and grouping by pull request would charge a session's whole cost to each of its PRs (one session linked 23 of them: $171 became 23 × $171).
- A strip shows how many sessions the period has, **how much of the cost subagents caused** (the Task / Agent tool) and **how much of the output was thinking**. Time and Rate appear per session only — sessions overlap in time, so they are never added up.
- Session work done by subagents is attributed to the session that started them (their transcripts live in the session's `subagents/` folder).
- Titles, branches and pull request repositories are masked by the eye (privacy mode) as `****`; the number of pull requests stays.
- New options `sessions` (`on`/`off`) and `sessionTitles` (`on`/`off`) in `config.json`. **Session titles are the only text-derived data this tool stores** (they summarise your conversation) — `"sessionTitles": "off"` stores none and removes the ones already recorded.

**Added — Prompt cache strip**
- Every tab shows the **cache hit rate** (cache reads ÷ input-side tokens), the **tokens served from the cache** and an estimate of **what the cache saved** (what the same tokens would have cost as plain input minus what they cost through the cache; cache writes cost a little more than input, so a write-heavy period can show a negative number). The saving is computed at today's prices — an estimate; recorded costs are never re-priced. Not available with the `ccusage` source.

**Added — `--doctor`**
- `node ~/.claude/dashboard/build.mjs --doctor` checks the setup and changes nothing: Node version, where the Claude Code logs are and how old the oldest transcript is, `cleanupPeriodDays` (and whether the ledger is on to keep the days Claude Code deletes), the ledger (schema, rows, first day, size, file permissions — it warns when `history.json` is readable by other users and suggests `chmod 600`), the age of the prices, the config and whether the output file can be written. Exit code 1 when something is broken.

**Changed — 1-hour cache writes are priced at the 1-hour rate**
- Claude Code records how long a cache write lives (5 minutes or 1 hour). Writes to the 1-hour cache are now priced at the 1-hour rate (2× the input price, per Anthropic's pricing page, checked against all 22 bundled models on 2026-10-09); before, every cache write used the 5-minute rate (1.25×), like ccusage does. Costs already recorded in `history.json` are not touched; a model price without a 1-hour rate (a `config.json` override) falls back to the 5-minute rate. On the maintainer's machine all cache writes were 5-minute ones, so nothing moved there — if you use 1-hour caching, new costs are higher than ccusage's and correct.

**Changed — `history.json` is now schema 4**
- Adds the 1-hour cache writes per bucket and the session tables (sessions, branches, cost per session × branch × model × subagent). Older files (schema 1–3) are read and upgraded on the first run, recorded costs untouched. Sessions start accumulating from that run on: days that Claude Code had already deleted have no sessions. A file from a *newer* version is still only read.

**Added — built-in log reader (default)**
- Reads `~/.claude/projects/**/*.jsonl` directly (also `$CLAUDE_CONFIG_DIR`, `~/.config/claude`). No `ccusage`, `npx` or network needed; a run takes ≈0.6 s versus ≈2.4 s via ccusage and ≈6 s for 1.1.x (maintainer's machine, 23 days of data).
- Verified against ccusage on real logs: **39 of 39** (day, model) cells identical in all four token counts and in cost with ccusage 19.0.3 and 20.0.26 (`npm run verify:ccusage`).
- Cost comes from LiteLLM's public price table: **refreshed once a day** when online and cached in `prices-cache.json`, with the table bundled in the package (`vendor/prices.json`, 22 Claude models as of 2026-10-08) as the baseline — so it works fully offline, with prices as fresh as your last online day. The page shows "prices as of <date>" (and warns when they are over a week old); the chat summary adds a note when they were not refreshed today. A model without a price is **flagged** (banner, warning) rather than silently priced at $0; add rates under `prices` in `config.json`. New: `priceRefresh`, `priceUrl`, `--refresh-prices`, `--offline`.
- New `source` option (`auto` | `logs` | `ccusage`) in `config.json` and `build.mjs --source`; `auto` falls back to ccusage when no usage records are found.

**Added — Time column (active time)**
- Every table gets a **Time** column after Cache read: the time you were actually working, measured from the timestamps of the Claude Code transcripts. Pauses longer than `idleMinutes` (default 10) are not counted, parallel sessions in one folder are counted once, and the Total row is the real time (work in two folders at once counts once there, but in both folder rows). Format `45m`, `3h 12m`, `5d 3h`. It is stored per 15-minute bucket in `history.json` (schema 3; older files are read and extended), so it survives Claude Code's transcript cleanup. New options `time` and `idleMinutes`. Reading the timestamps means parsing every transcript line (≈ +0.1 s on 130 MB of logs); message text is not stored.

**Added — Rate column (Cost ÷ Time)**
- Every table gets a **Rate** column after Time: the cost of one hour of active work, `$/h`. The numerator is the cost of just the days that have a measured time (a day with usage but no time data would otherwise inflate the rate); a period with such days shows `~ $x/h`, no time or under a minute of it shows `—`. The Total row divides by the real, united time. Hidden together with Time (`"time": "off"`, ccusage source).

**Added — privacy mode (the eye)**
- An eye button next to the theme toggle. Open (default) shows everything as before; click it and it closes: every project name on screen is replaced by `****` per path segment (`~/ok/code_p/app` → `~/****/****/****`) — in the Today and Projects tables (including the hover path), the chart axis and tooltips, and the Min / Max cards. Folder structure, numbers, `~`, `.. (this folder)`, `(unattributed)` and `+N more` stay, so you can show the dashboard without showing what you work on. The choice applies to all tabs and is not remembered: every newly generated or reloaded page starts with the eye open. The button is hidden when the page has no project data.
- It masks what is *displayed*, it is not encryption: the generated `index.html` still contains the names (view-source, saving the file), so share a screenshot or a screen share, not the file.

**Changed — generation time in local time**
- The sub-line reads `Generated at 2026-10-09 01:28:52 GMT+3` (your local date and time with the zone offset, e.g. `GMT+5:30`, `GMT`) instead of a UTC ISO stamp, so you can tell when the report was made without adding or subtracting hours.

**Added — average line on the bar chart**
- The cost chart gets a thin dashed red line labelled `Avg $x` at the value of the Avg card, so every bar reads as above or below average. It always sits at the value of the Avg card: `Avg $x` on every tab (on Today by project it is the daily average; on Projects and Sessions the average per project or session). The cost axis is stretched to reach the line when every bar is lower. On Today by project the first bar is **Total** (all projects, stacked by model), so you can see at a glance whether today as a whole is still under the average line.

**Changed — the figures are one block**
- Min / Avg / Max cost, the prompt-cache figures and (on the Sessions tab) the session figures are one card divided by thin horizontal lines — two rows on every tab, three on Sessions, three label / value cells per row — instead of separate cards. A thin vertical divider in the tab bar separates the time views (Today … Monthly) from the views by what the money went to (Projects, Sessions).

**Changed — compact token counts, no wrapping**
- Input / Output / Cache write / Cache read in the tables are shown compactly (`842`, `10.2k`, `4.3M`, `1.4B`; the exact number is the cell's tooltip), and the Time, Rate and Last activity cells never wrap, so every row keeps its height on a narrow window (only the Models column wraps).

**Added — Projects tab**
- New **Projects** tab with the period chips 1d (today) / 7d / 30d / 90d / 1y / All (default All): a per-project cost table shaped as an expandable folder tree (ancestors add up their descendants; `~` is not a project, so its children are the top level; paths outside the home folder form their own roots; usage without a working directory is "(unattributed)"), the Total row, a chart of the biggest folders by model with a "+N more" bar, the model doughnut, and Min / Avg / Max cost per project. The tab is hidden when project data is not available (ccusage source or `"projects": "off"`). Project rows now cover the whole history, not only 31 days.

**Added — Today by project**
- On the Today tab the table lists the projects you worked in today (the working directory of each message, relative to `~`; two path parts, e.g. `ok/code`, longer only when two projects would look the same), most expensive first, under the Total row; the chart becomes "Cost per project today (by model)" with one stack per project (axis labels longer than 20 characters are clipped with "…"; hover a bar for the full path). Min/Avg/Max keep showing the last 30 days. With no usage yet today the table says so. `history.json` moves to schema 2 (per-project rows); a file from the earlier build is migrated automatically — rows that the current logs still cover are replaced by project-attributed ones, older rows are kept as "(unattributed)" with their recorded cost. New option `projects`.

**Added — durable history**
- Claude Code removes transcripts older than 30 days by default, which is why the dashboard used to show only the last month or two. `history.json` (see Configuration) now keeps usage and its cost past that cleanup, per 15-minute UTC bucket (so a time-zone change cannot double-count) and model. Cost is recorded when a bucket is first seen and never re-priced; growth is charged at the then-current prices. Older data that Claude Code has already deleted cannot be recovered. New: `history` option, `--reset-history`.

**Fixed**
- A week that crosses New Year is split in two (e.g. `2025-12-29` and `2026-01-01`), each part in its own year. Before, its January days were listed under the previous year in the Weekly tab, so a year's Weekly total did not match its Daily and Monthly totals, and the year drop-down could offer a year with no days in it. Boundary weeks are therefore partial.
- Duplicate streaming entries are collapsed to the final one (≈50% of assistant lines in real logs are partial duplicates). ccusage ≤ 18 keeps the *first* one and under-counts output tokens — on the maintainer's data 322,876 output tokens (≈1.2% of cost). This explains the difference between ccusage 18 and 19+ noted under 1.2.0; the built-in reader matches 19+. **Numbers can therefore go up by about that much compared to 1.2.0 on the same logs.**

**Changed**
- The four summary cards at the top (total cost, total tokens, cache read, periods) are gone: their numbers are now the first, highlighted **Total** row of the breakdown table (sums per column for the current tab and year; total tokens is the sum of the four token columns; the number of periods is in the Avg card). Min / Avg / Max cost cards are now meaningful on every tab: Daily, Weekly and Monthly cover all rows of the table (selected year) and name the date / week start / month of the minimum and maximum; Today covers the last 30 calendar days (days that had usage) instead of showing the same number three times.
- Installed as `~/.claude/skills/<prefix>-usage/SKILL.md` with `disable-model-invocation: true` — Claude never invokes it on its own and, per the Claude Code docs, a skill with that flag is kept out of the model's context. Custom commands are the deprecated predecessor of skills.
- The skill body uses the documented injection form `` !`cmd` `` instead of a bare `!cmd` line.
- New `npm run copy-skill` / `--skill`; `copy-command` / `--command` stay as aliases.

**Upgrading from 1.2.x**
- Re-run setup. A command that this package installed (`~/.claude/commands/<prefix>-usage.md`) is removed and replaced by the skill. A skill or command with the same name that this package did not create is never overwritten without `--force`; a foreign command with that name is reported as a name collision (which one wins is not documented — remove one).

**Known**
- Pricing limits: long-context surcharges are not modelled (two older models, `claude-sonnet-4-5*`, are marked `"tiered"` in the snapshot); fast mode, the 1.1× multiplier for US-only inference and web-search fees ($10 per 1,000 searches, per Anthropic's pricing page) are not modelled — the logs carry the counts, none of these showed up in the maintainer's data. Contracted or discounted prices (enterprise, `modelPricing`) are not known to the logs either: figures are list prices.
- The ledger prices a bucket when the dashboard first sees it: if you run it rarely, activity from the days in between is priced with the table available at that run (the latest one, refreshed daily when online).
- **Time is only known for what the dashboard has seen**: days older than Claude Code's transcript retention that were already in `history.json` before this version have no time (`—`), and a day whose transcripts were partly cleaned up shows only what was left. A folder row adds up its subfolders' time, so work in two sibling folders at the same moment counts in both rows (the Total is the real figure). The measure is activity, not effort: reading a long answer without sending anything for more than the idle threshold is not counted.
- The project is the message's own working directory, so a session that `cd`s around shows up as several rows (e.g. a repo and its `test` folder), and `~/.claude/skills/...` helper work is listed separately. A folder you start sessions from but work in other repositories (like a workspace root) is one row of its own (".. (this folder)") — the logs cannot say which repository the work was about.
- A change of the Claude Code log format would need a reader update; set `source` to `ccusage` as a workaround.
- Claude still produces a short reply after the dashboard output is injected (documented behaviour for skills); `model:`/`effort:` pinning to make it cheaper is not used because it is not in the official skills reference.

## v1.2.0

Rewritten in Node.js, compatible with current ccusage, and hardened. The command name, `--no-open` / `--no-summary` flags, `CC_USAGE_PREFIX` and the install locations are unchanged.

**Fixed — it broke on current ccusage**
- With ccusage 19.x / 20.x (what `npx` fetches when ccusage is not installed globally) 1.1.x failed with `KeyError: 'date'` after writing an unusable `index.html`. It now reads the Claude-only report (`ccusage claude daily`) and falls back to `ccusage daily` for older versions. Tested end-to-end with ccusage 12.4.0, 15.10.0, 17.2.1, 18.0.11, 19.0.3 and 20.0.26 — identical days / weeks / months / models on the same logs.
- Unexpected ccusage output now stops with a readable message instead of rendering an empty $0 dashboard.
- The generator no longer fails on long histories (1.1.x hit the OS argument limit at roughly 1,000–1,500 days with usage, measured with synthetic data).
- "Last 7 days" in the chat summary covered 8 days; it is now 7 (today + previous 6).
- A failed browser launch no longer fails the build (and `open` is no longer macOS-only).
- The dashboard no longer renders blank when `localStorage` is unavailable.

**Security**
- Embedded data and names are escaped. In 1.1.x a model name containing `</script>` broke out of the data block and executed injected script (reproduced in Chrome); the new build renders it as text. The installer also refuses to overwrite a `<prefix>-usage.md` it did not create.

**Added**
- `config.json` next to `build.mjs` — `weekStart`: `auto` (follows your system locale), or `sunday` … `saturday`.
- The package version in the dashboard footer.
- Generator options `--out`, `--template`, `--config`, `--help`; installer flags `--prefix`, `--force`, `--dashboard`, `--command`; `$CLAUDE_CONFIG_DIR` is honoured.
- Unit tests (`npm test`, 35 tests, no dependencies).

**Changed**
- Generator and installer are now Node.js (`build.mjs`, `lib/`, `bin/install.mjs`) — no `bash` or `python3` required.
- One ccusage call instead of three; weekly and monthly rows are computed locally from daily data, so weeks follow your `weekStart` regardless of the ccusage version. On the maintainer's machine (23 days of data, ccusage 18) a run went from ≈6.1 s to ≈2.3 s (median of 5 alternating runs; timings vary by machine).
- Chart.js 4.4.6 is bundled into the generated HTML: the page loads no external resources and works offline. The generated file grows from ≈34 KB to ≈239 KB; the npm package from ≈302 kB to ≈379 kB.
- `npm run build` renders the repo's own `template.html` to `./index.html` (previously it re-rendered the *installed* copy).
- The unused `ccusage` dependency was removed from `package.json`.
- Installer versions compare as semver (`1.2.0-beta.1` no longer outranks `1.2.0`).

**Upgrading from 1.1.x**
- Re-run `npx ccusage-ui-dashboard@latest` (or `npm run setup`). `~/.claude/dashboard/build.sh` is kept as a one-line shim that runs `build.mjs`, so existing skills, symlinks and shell aliases keep working; fresh installs do not create it.
- Unknown `build` options are now rejected (1.1.x silently ignored them).
- If a `<prefix>-usage.md` was not installed by this package, setup stops with an error; choose another prefix or pass `--force`.

**Known limitations**
- On the same logs, ccusage 19.x / 20.x report about 1.2% higher cost than 12.x–18.x (measured: $483.47 vs $477.62). This is ccusage's own accounting; the cause was not investigated.
- Developed and tested on macOS. Linux and Windows use the same code but are untested. The `npx github:…` install path (Option B) has not been tested under npm 12's `--allow-git` default.

## v1.1.1

- Slash command no longer registered as a skill — `/<prefix>-usage` is now a pure slash command, removing the model-trigger overhead on every invocation.
- Removed the post-bash instruction prompt from the command file, so the model no longer generates a response after running the bash script.

## v1.1.0

- **Light / dark theme toggle** — sun/moon button in the dashboard header; chart colors update on switch; preference persisted in `localStorage`.
- Slash command prompt trimmed to reduce token usage on each `/<prefix>-usage` invocation.

## v1.0.0

Initial public release.

- Self-contained HTML dashboard (no server, no telemetry).
- `/<prefix>-usage` Claude Code slash command — inline cost summary in chat + visual dashboard in browser.
- KPI cards (total cost, tokens, cache reads, periods) + min/avg/max per period.
- Period tabs: Today / Daily / Weekly / Monthly with year filter dropdown.
- Stacked bar chart + doughnut (cost by model, stable color slots across tabs).
- Detailed breakdown table (input / output / cache-write / cache-read tokens).
- `npx ccusage-ui-dashboard` one-shot install from npm.
- `--no-open` and `--no-summary` flags for `build.sh`.
- VS Code Simple Browser tip when running inside a VS Code terminal.
