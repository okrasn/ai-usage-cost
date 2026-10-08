# ccusage-ui-dashboard

A local visual dashboard for **Claude Code** usage — cost, tokens, model split — across day / week / month / year.

> **Main feature:** type `/<prefix>-usage` inside any Claude Code session and get an inline cost & token summary _right in the chat_, plus the full visual dashboard opens in your browser — all without leaving your terminal.

![Dashboard example](./example.jpg)

The dashboard runs entirely on your machine. It reads local Claude Code logs
(`~/.claude/projects/*/*.jsonl`) via [`ccusage`](https://github.com/ryoppippi/ccusage),
embeds the parsed data into a self-contained HTML file, and opens it in your browser.
No server, no telemetry, no external API calls — Chart.js is bundled into the generated file, so the dashboard also works offline.

## Features

- **`/<prefix>-usage` slash command** — type it in any Claude Code session to get an inline cost & token summary in the chat and open the full visual dashboard in one step.
- **KPIs**: total cost, total tokens, cache reads, number of periods.
- **Period tabs**: `Today` · `Daily` · `Weekly` · `Monthly`.
- **Year dropdown** (right of the tabs) — populated from all years available in your data.
- **Min / Avg / Max cost** per period for the active view.
- **Stacked bar chart** of cost per period, broken down by model, with **stable model colors** across all tabs (the priciest model always keeps the same color slot).
- **Doughnut** with cost share by model.
- **Detailed table** with input / output / cache-write / cache-read tokens per period.
- **Light / dark theme toggle** — sun/moon button in the header, preference persisted in `localStorage`.
- Inline markdown summary printed to stdout — Today / Last 7 days / This month / All time + top models by cost.
- **Works offline and on any machine where ccusage runs** — Chart.js is bundled into the generated file; only Node.js is required (ccusage 12.4.0 – 20.x).
- **Week start follows your locale** — or set it in `config.json` (see [Configuration](#configuration)).

## Requirements

- Any machine where [`ccusage`](https://github.com/ryoppippi/ccusage) runs, plus a modern browser. Everything here is plain Node.js — no `bash` or `python3` needed. Developed and tested on macOS; Linux and Windows use the same code but are untested.
- Node.js ≥ 18 with `npm`/`npx` (`npx` resolves `ccusage` on first run; a globally installed `ccusage` is used first). Works with ccusage 12.4.0 – 20.x.
- Claude Code CLI installed (so that `~/.claude/` exists and the slash command is picked up).

## Installation

### Option A — one-shot via `npx` from npm (recommended)

No clone required. Installs from the npm registry:

```bash
npx ccusage-ui-dashboard
```

Pass the prefix non-interactively:

```bash
CC_USAGE_PREFIX=ok npx ccusage-ui-dashboard
```

### Option B — one-shot via `npx` from GitHub

Pulls the package straight from GitHub — useful before an npm release:

```bash
npx github:okrasn/ccusage-ui-dashboard
```

Pin a tag/version if you want reproducibility:

```bash
npx github:okrasn/ccusage-ui-dashboard#v1.0.0
```

You can also pass the prefix non-interactively:

```bash
CC_USAGE_PREFIX=ok npx github:okrasn/ccusage-ui-dashboard
```

### Option C — clone and run setup

```bash
git clone https://github.com/okrasn/ccusage-ui-dashboard.git
cd ccusage-ui-dashboard
npm run setup
```

Either path triggers the same flow. `setup` first prompts for a
**command prefix** (default `my`, so the slash command becomes `/my-usage`;
pick anything matching `[A-Za-z0-9_-]+`, e.g. `ok` → `/ok-usage`). To skip the
prompt, pass it via env: `CC_USAGE_PREFIX=ok npm run setup`.

Then it runs the full cascade:

1. **`copy-dashboard`** — copies `build.mjs`, `lib/`, `vendor/` and `template.html` into `~/.claude/dashboard/` (or `$CLAUDE_CONFIG_DIR/dashboard/`).
2. **`copy-command`** — copies the slash command into `~/.claude/commands/<prefix>-usage.md`.

After it finishes, open any Claude Code session and type:

```
/<prefix>-usage    # e.g. /my-usage or /ok-usage
```

You'll get an inline markdown summary in chat **and** the full visual dashboard
will open in your default browser.

### Step-by-step (if you prefer)

```bash
npm run copy-dashboard          # dashboard files → ~/.claude/dashboard/
CC_USAGE_PREFIX=my npm run copy-command  # slash command → ~/.claude/commands/my-usage.md
```

`copy-command` reads the prefix from `--prefix` or the `CC_USAGE_PREFIX` env var; without
either it prompts interactively (defaulting to a command previously installed by this package,
or `my` on a fresh machine; non-interactive runs use that default). The variable is named
`CC_USAGE_PREFIX` deliberately — `PREFIX` collides with npm's own `--prefix` config.

It never overwrites a `<prefix>-usage.md` that this package did not install — pick another
prefix, or pass `--force`. Pass `--force` to either step to reinstall the same version.

### Optional — shell alias

Add to `~/.zshrc` (or `~/.bashrc`):

```bash
alias <prefix>-usage='node ~/.claude/dashboard/build.mjs'
```

Reload the shell, then run `<prefix>-usage` from anywhere to rebuild and open the dashboard.

## Usage

### From the terminal

```bash
node ~/.claude/dashboard/build.mjs                          # rebuild + summary + open browser
node ~/.claude/dashboard/build.mjs --no-open                # rebuild + summary, no browser
node ~/.claude/dashboard/build.mjs --no-summary             # rebuild + open, no summary
node ~/.claude/dashboard/build.mjs --no-open --no-summary   # silent rebuild
node ~/.claude/dashboard/build.mjs --help                   # all options (--out, --template, --config)
```

Each run regenerates `~/.claude/dashboard/index.html` with fresh data.

### Configuration

Optional `config.json` next to `build.mjs` (`~/.claude/dashboard/config.json`; never overwritten by upgrades):

```json
{ "weekStart": "monday" }
```

- `weekStart` — `auto` (default: follows your system locale), or `sunday` … `saturday`. Weeks are
  computed locally from daily data, so they always follow this setting regardless of the ccusage version.
  Note: `auto` uses the locale's region default; a custom "first day of week" set in the OS
  calendar settings is not visible to Node, so set it here explicitly if it differs.

### From Claude Code — `/<prefix>-usage`

Inside any Claude Code session:

```
/<prefix>-usage    # e.g. /my-usage or /ok-usage
```

It will:

1. Run `build.mjs` to rebuild the dashboard with fresh data.
2. Render the markdown summary inline in the chat (Today / Last 7 days / This month / All time + top models).
3. Open the full visual dashboard in your default browser.
4. If launched from a VS Code integrated terminal, also print a tip with a
   ready-to-paste `file://` URL for VS Code's **Simple Browser** (`Cmd+Shift+P` →
   `Simple Browser: Show`) — for viewing the dashboard in a side tab inside
   VS Code instead of a separate browser window.

> The slash command name comes from the prefix you chose at setup time — it's
> stored as `~/.claude/commands/<prefix>-usage.md`. Re-run `npm run setup` with
> a different `CC_USAGE_PREFIX` to add another (the previous file is left in place).

> **Why not auto-open in Simple Browser?** The `code` CLI does not expose a way to
> invoke arbitrary VS Code commands like `simpleBrowser.show` from a script. The
> printed URL is the most reliable cross-version solution without writing a
> custom VS Code extension.

## Available npm scripts

| Script                   | What it does                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `npm run setup`          | Prompts for command prefix (default `my`), then runs the full setup cascade           |
| `npm run copy-dashboard` | Copies the dashboard files into `~/.claude/dashboard/` (version-aware)                |
| `npm run copy-command`   | Writes `~/.claude/commands/<prefix>-usage.md` (uses `CC_USAGE_PREFIX` env or prompts) |
| `npm run build`          | Renders **this repo's** `template.html` to `./index.html` and opens it (dev loop)     |
| `npm start`              | Same as `npm run build`                                                               |
| `npm test`               | Runs the unit tests (`node --test`, no dependencies)                                  |

> The installer compares the version in [`package.json`](./package.json)
> against the version recorded next to the installed files (`.version` /
> `.<prefix>-usage.version`). It overwrites only when the package version is
> strictly newer (prereleases sort below their release); otherwise it skips —
> pass `--force` to reinstall.

## Repo layout

```
ccusage-ui-dashboard/
├── package.json              # npm package manifest (declares `bin` for npx)
├── README.md                 # this file
├── build.mjs                 # generator: ccusage --json → embed → open + summary
├── lib/                      # ccusage runner, data adapter, aggregation, rendering, summary, installer
├── template.html             # UI template (__DATA__, __USER_NAME__, __CHARTJS__ placeholders)
├── vendor/                   # Chart.js 4.4.6 (MIT), inlined into the generated HTML
├── bin/
│   └── install.mjs           # npx entrypoint (`npx ccusage-ui-dashboard`) and `npm run setup`
├── commands/
│   └── ok-usage.md           # Claude Code slash command template
└── test/                     # node:test unit tests
```

After running `npm run setup` on a new machine, the installed layout is:

```
~/.claude/dashboard/
├── build.mjs, lib/, vendor/, template.html
├── config.json               # optional, yours — never overwritten
└── index.html                # generated on each build

~/.claude/commands/
└── <prefix>-usage.md         # makes /<prefix>-usage available in Claude Code
```

## Customisation

- **Colors** — edit the `COLORS` array in `template.html` (`<script>` block).
- **Footer / branding** — `<footer class="footer">` in `template.html`.
- **Title** — `<title>` and `<h1>` in `template.html`.
- **What min/avg/max measure** — currently `totalCost` per period; swap to
  `totalTokens` in the `render()` function if you prefer a token-based stat.
- **Inline summary contents** — edit `lib/summary.mjs` to add/remove rows or change
  formatting. The output goes straight into Claude Code's chat via `/<prefix>-usage`.
- **Slash command behavior** — edit `commands/ok-usage.md` (in this repo) to
  change what Claude says alongside the summary, then rerun
  `CC_USAGE_PREFIX=<your-prefix> npm run copy-command` (or just
  `npm run copy-command` to be re-prompted) to redeploy. To switch the prefix,
  run setup again with a different `CC_USAGE_PREFIX`.

> **Heads up:** if you customise files inside `~/.claude/dashboard/` directly
> (not in this repo), a newer version of this package will overwrite them on the next
> `copy-dashboard` (only `config.json` is preserved). Treat this repo as the source of truth
> and edit here — `npm run build` previews your repo changes without installing anything.

## Privacy

All data stays local. The generated HTML makes no network requests (Chart.js is inlined).
The only network access is `npx` fetching `ccusage` itself when it is not installed yet.

## Changelog

### v1.2.0

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

### v1.1.1

- Slash command no longer registered as a skill — `/<prefix>-usage` is now a pure slash command, removing the model-trigger overhead on every invocation.
- Removed the post-bash instruction prompt from the command file, so the model no longer generates a response after running the bash script.

### v1.1.0

- **Light / dark theme toggle** — sun/moon button in the dashboard header; chart colors update on switch; preference persisted in `localStorage`.
- Slash command prompt trimmed to reduce token usage on each `/<prefix>-usage` invocation.

### v1.0.0

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

## Licence

MIT — see [`LICENSE`](./LICENSE).
