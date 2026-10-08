import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../build.mjs";
import { classicRow } from "./helpers.mjs";

const TEMPLATE = "<title>__USER_NAME__</title>\n<script>__CHARTJS__</script>\n<script>\nconst DATA = __DATA__;\n</script>\n";
const NOW = new Date(2026, 9, 8, 12, 0, 0);

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccud-build-"));
  const template = join(dir, "template.html");
  writeFileSync(template, TEMPLATE);
  const logs = [];
  const deps = {
    fetch: () => ({ daily: [classicRow("2026-10-07", 2), classicRow("2026-10-08", 3)] }),
    userName: () => "Ada",
    open: () => true,
    now: NOW,
    log: m => logs.push(m),
    ...extra,
  };
  return { dir, template, out: join(dir, "out", "index.html"), logs, deps };
}

const dataOf = html => JSON.parse(html.match(/^const DATA = (.*);$/m)[1]);

test("renders template → out (dev mode: explicit --template/--out) and prints the summary", () => {
  const { template, out, logs, deps } = setup();
  assert.equal(main(["--no-open", "--template", template, "--out", out, "--config", "/nonexistent"], deps), 0);
  const html = readFileSync(out, "utf8");
  const data = dataOf(html);
  assert.equal(data.daily.length, 2);
  assert.equal(data.monthly[0].totalCost, 5);
  assert.equal(data.generatedAt, NOW.toISOString());
  assert.equal(data.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.ok(html.includes("<title>Ada</title>"));
  assert.ok(!/__DATA__|__USER_NAME__|__CHARTJS__/.test(html));
  assert.ok(html.includes("Chart.js v4.4.6"), "Chart.js is inlined");
  assert.ok(!html.includes("cdn.jsdelivr"), "no CDN reference");
  assert.ok(logs.some(l => l.includes("quick summary")));
  assert.ok(logs.some(l => l.includes(`Dashboard regenerated: ${out}`)));
});

test("config.json weekStart is applied", () => {
  const { dir, template, out, deps } = setup();
  const config = join(dir, "config.json");
  writeFileSync(config, '{"weekStart":"sunday"}');
  main(["--no-open", "--template", template, "--out", out, "--config", config], deps);
  assert.equal(dataOf(readFileSync(out, "utf8")).weekly[0].week, "2026-10-04");
  writeFileSync(config, '{"weekStart":"monday"}');
  main(["--no-open", "--template", template, "--out", out, "--config", config], deps);
  assert.equal(dataOf(readFileSync(out, "utf8")).weekly[0].week, "2026-10-05");
});

test("--no-summary and --no-open are honoured; a failed browser launch does not fail the build", () => {
  let opened = 0;
  const a = setup({ open: () => (opened++, true) });
  main(["--no-open", "--no-summary", "--template", a.template, "--out", a.out, "--config", "/x"], a.deps);
  assert.equal(opened, 0);
  assert.ok(!a.logs.some(l => l.includes("quick summary")));

  const b = setup({ open: () => false });
  assert.equal(main(["--no-summary", "--template", b.template, "--out", b.out, "--config", "/x"], b.deps), 0);
  assert.ok(b.logs.some(l => l.includes("open this file manually")));
});

test("bad ccusage output or config fails before touching the output file", () => {
  const bad = setup({ fetch: () => ({ weekly: [] }) });
  assert.throws(() => main(["--template", bad.template, "--out", bad.out, "--config", "/x"], bad.deps), /no "daily" array/);
  assert.ok(!existsSync(bad.out));

  const cfg = setup();
  const config = join(cfg.dir, "config.json");
  writeFileSync(config, '{"weekStart":"funday"}');
  assert.throws(() => main(["--template", cfg.template, "--out", cfg.out, "--config", config], cfg.deps), /weekStart/);
  writeFileSync(config, "{nope");
  assert.throws(() => main(["--template", cfg.template, "--out", cfg.out, "--config", config], cfg.deps), /not valid JSON/);
});

test("unknown options are rejected", () => {
  const { deps } = setup();
  assert.throws(() => main(["--wat"], deps), /unknown option/);
});
