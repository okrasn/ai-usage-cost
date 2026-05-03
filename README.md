# ccusage-ui-dashboard

A local visual dashboard for **Claude Code** usage — cost, tokens, model split — across day / week / month / year.

> **Main feature:** type `/<prefix>-usage` inside any Claude Code session and get an inline cost & token summary _right in the chat_, plus the full visual dashboard opens in your browser — all without leaving your terminal.

![Dashboard example](./example.jpg)

The dashboard runs entirely on your machine. It reads local Claude Code logs
(`~/.claude/projects/*/*.jsonl`) via [`ccusage`](https://github.com/ryoppippi/ccusage),
embeds the parsed data into a self-contained HTML file, and opens it in your browser.
No server, no telemetry, no external API calls — except the Chart.js CDN script tag.

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

## Requirements

- macOS or Linux with `bash`, `python3`, and a modern browser.
- Node.js ≥ 18 and `npm` (used by `npx` to resolve `ccusage` on first run).
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

1. **`copy-dashboard`** — copies `build.sh` and `template.html` into `~/.claude/dashboard/`.
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

`copy-command` reads the prefix from `CC_USAGE_PREFIX` env var; without it,
it'll prompt interactively (defaulting to any existing `*-usage.md` install,
or `my` on a fresh machine). The variable is named `CC_USAGE_PREFIX`
deliberately — `PREFIX` collides with npm's own `--prefix` config.

### Optional — shell alias

Add to `~/.zshrc` (or `~/.bashrc`):

```bash
alias <prefix>-usage='~/.claude/dashboard/build.sh'
```

Reload the shell, then run `<prefix>-usage` from anywhere to rebuild and open the dashboard.

## Usage

### From the terminal

```bash
~/.claude/dashboard/build.sh                          # rebuild + summary + open browser
~/.claude/dashboard/build.sh --no-open                # rebuild + summary, no browser
~/.claude/dashboard/build.sh --no-summary             # rebuild + open, no summary
~/.claude/dashboard/build.sh --no-open --no-summary   # silent rebuild
```

Each run regenerates `~/.claude/dashboard/index.html` with fresh data.

### From Claude Code — `/<prefix>-usage`

Inside any Claude Code session:

```
/<prefix>-usage    # e.g. /my-usage or /ok-usage
```

It will:

1. Run `build.sh` to rebuild the dashboard with fresh data.
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
| `npm run copy-dashboard` | Copies `build.sh` + `template.html` into `~/.claude/dashboard/` (version-aware)       |
| `npm run copy-command`   | Copies `commands/ok-usage.md` into `~/.claude/commands/<prefix>-usage.md` (uses `CC_USAGE_PREFIX` env or prompts) |
| `npm run build`          | Same as `npm start`                                                                   |
| `npm start`              | Generates `index.html` and opens it in your default browser                           |

> Both copy scripts compare the version in [`package.json`](./package.json)
> against the version recorded next to the installed files (`.version` /
> `.<prefix>-usage.version`). They overwrite only when the repo version is
> strictly newer; otherwise they skip.

## Repo layout

```
ccusage-ui-dashboard/
├── package.json              # npm package manifest (declares `bin` for npx)
├── README.md                 # this file
├── build.sh                  # generator: ccusage --json → embed → open + summary
├── template.html             # UI template with __DATA__ placeholder
├── bin/
│   └── install.sh            # npx entrypoint (`npx ccusage-ui-dashboard`)
├── commands/
│   └── ok-usage.md           # Claude Code slash command
└── scripts/
    ├── setup.sh              # used by `npm run setup` and the npx entrypoint
    ├── copy-dashboard.sh     # used by `npm run copy-dashboard`
    └── copy-command.sh       # used by `npm run copy-command`
```

After running `npm run setup` on a new machine, the installed layout is:

```
~/.claude/dashboard/
├── build.sh
├── template.html
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
- **Inline summary contents** — edit the Python block in `build.sh` (after the
  `if [[ "$NO_SUMMARY" -eq 0 ]]; then` line) to add/remove rows or change
  formatting. The output goes straight into Claude Code's chat via `/<prefix>-usage`.
- **Slash command behavior** — edit `commands/ok-usage.md` (in this repo) to
  change what Claude says alongside the summary, then rerun
  `CC_USAGE_PREFIX=<your-prefix> npm run copy-command` (or just
  `npm run copy-command` to be re-prompted) to redeploy. To switch the prefix,
  run setup again with a different `CC_USAGE_PREFIX`.

> **Heads up:** if you customise files inside `~/.claude/dashboard/` directly
> (not in this repo), running `npm run copy-dashboard` again will overwrite them. Treat
> this repo as the source of truth and edit here.

## Privacy

All data stays local. The only network request the dashboard makes is to
`cdn.jsdelivr.net` for `chart.js`. If you want a fully offline build, download
`chart.umd.min.js` next to `template.html` and replace the `<script src="...">`
URL with a relative path.

## Changelog

### v1.1.0

- **Light / dark theme toggle** — sun/moon button in the dashboard header; chart colors update on switch; preference persisted in `localStorage`.
- Slash command prompt trimmed to reduce token usage on each `/ok-usage` invocation.

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
