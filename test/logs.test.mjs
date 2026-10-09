import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bucketsToProjectCells, logRoots, projectOf, readLogs } from "../lib/logs.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ccud-logs-"));
// timestamps built from LOCAL time, so the expected date is the same in any time zone
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const entry = (over = {}) => JSON.stringify({
  type: "assistant", timestamp: at(2026, 10, 8, 12), requestId: "req1",
  message: { id: "msg1", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } },
  ...over,
});
const withUsage = (id, req, out, extra = {}) => entry({ requestId: req, message: { id, model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...extra } });

function project(lines, name = "s.jsonl") {
  const root = tmp();
  mkdirSync(join(root, "p1", "nested"), { recursive: true });
  writeFileSync(join(root, "p1", "nested", name), lines.join("\n") + "\n");
  return root;
}

test("streaming duplicates (same message.id + requestId) collapse to the entry with the final output_tokens", () => {
  const root = project([withUsage("m1", "r1", 5), withUsage("m1", "r1", 300), withUsage("m1", "r1", 120)]);
  const { cells, stats } = readLogs({ roots: [root] });
  assert.equal(cells.length, 1);
  assert.equal(cells[0].output, 300);
  assert.equal(stats.duplicates, 2);
  assert.equal(stats.records, 1);
});

test("different ids or requestIds are separate records; entries without ids are never deduplicated", () => {
  const noIds = JSON.stringify({ type: "assistant", timestamp: at(2026, 10, 8, 9), message: { model: "claude-sonnet-5", usage: { input_tokens: 2, output_tokens: 3 } } });
  const root = project([withUsage("m1", "r1", 10), withUsage("m1", "r2", 10), withUsage("m2", "r1", 10), noIds, noIds]);
  const { cells } = readLogs({ roots: [root] });
  assert.equal(cells[0].output, 10 + 10 + 10 + 3 + 3);
  assert.equal(cells[0].input, 1 + 1 + 1 + 2 + 2);
});

test("groups by local day and model; skips synthetic, usage-less, malformed and bad-timestamp lines", () => {
  const root = project([
    entry({ timestamp: at(2026, 10, 8, 0, 5), requestId: "a", message: { id: "a", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } } }),
    entry({ timestamp: at(2026, 10, 7, 23, 55), requestId: "b", message: { id: "b", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } } }),
    entry({ requestId: "c", message: { id: "c", model: "<synthetic>", usage: { input_tokens: 99, output_tokens: 99 } } }),
    JSON.stringify({ type: "user", message: { content: "hello \"usage\" in text" } }),
    entry({ requestId: "d", timestamp: "not a date", message: { id: "d", model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 5 } } }),
    "{ this is not json \"usage\"",
  ]);
  const { cells } = readLogs({ roots: [root] });
  const byDay = Object.fromEntries(cells.map(c => [c.date, c.input]));
  assert.deepEqual(byDay, { "2026-10-08": 1, "2026-10-07": 1 });
});

test("a model without a name is kept as 'unknown' (it will be reported as unpriced, not dropped)", () => {
  const root = project([entry({ requestId: "z", message: { id: "z", usage: { input_tokens: 4, output_tokens: 4 } } })]);
  assert.equal(readLogs({ roots: [root] }).cells[0].model, "unknown");
});

test("logRoots: CLAUDE_CONFIG_DIR wins (comma-separated); defaults are XDG then ~/.claude; duplicates and missing dirs are dropped", () => {
  const a = tmp(), b = tmp();
  mkdirSync(join(a, "projects")); mkdirSync(join(b, "projects"));
  assert.deepEqual(logRoots({ env: { CLAUDE_CONFIG_DIR: `${a}, ${b} ,/does/not/exist` }, home: "/nope" }), [join(a, "projects"), join(b, "projects")]);

  const home = tmp();
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".config", "claude", "projects"), { recursive: true });
  assert.deepEqual(logRoots({ env: {}, home }), [join(home, ".config", "claude", "projects"), join(home, ".claude", "projects")]);

  const same = tmp();
  mkdirSync(join(same, "real", "projects"), { recursive: true });
  symlinkSync(join(same, "real"), join(same, "link"));
  assert.equal(logRoots({ env: { CLAUDE_CONFIG_DIR: `${join(same, "real")},${join(same, "link")}` }, home: "/nope" }).length, 1);
  assert.deepEqual(logRoots({ env: {}, home: tmp() }), []);
});

test("buckets are 15-minute UTC slices per model; cells are their local-day sums", () => {
  const e = (min, id, out) => entry({ timestamp: at(2026, 10, 8, 12, min), requestId: id, message: { id, model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const root = project([e(1, "a", 10), e(14, "b", 20), e(16, "c", 30)]);
  const { buckets, cells } = readLogs({ roots: [root] });
  assert.equal(buckets.length, 2, "minutes 1 and 14 share a quarter-hour, minute 16 starts the next");
  assert.deepEqual(buckets.map(x => x.output).sort((p, q) => p - q), [30, 30]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].output, 60);
});

test("projectOf: the message's working directory relative to the home directory", () => {
  assert.equal(projectOf("/Users/me/ok/app", "/Users/me"), "~/ok/app");
  assert.equal(projectOf("/Users/me", "/Users/me"), "~");
  assert.equal(projectOf("/Users/me/", "/Users/me"), "~");
  assert.equal(projectOf("/Users/meow/app", "/Users/me"), "/Users/meow/app", "a sibling that merely shares the prefix is not under home");
  assert.equal(projectOf("/srv/app/", "/Users/me"), "/srv/app");
  assert.equal(projectOf("C:\\Users\\me\\app", "C:\\Users\\me"), "~\\app");
  assert.equal(projectOf(undefined, "/Users/me"), "");
  assert.equal(projectOf("", "/Users/me"), "");
});

test("buckets are per project: the same quarter-hour and model in two directories stay separate; cells still sum them", () => {
  const e = (id, cwd, out) => entry({ requestId: id, cwd, message: { id, model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const root = project([e("a", "/Users/me/ok/app", 10), e("b", "/Users/me/ok/lib", 20), e("c", "/Users/me/ok/app", 5), e("d", undefined, 1)]);
  const { buckets, cells } = readLogs({ roots: [root], home: "/Users/me" });
  const byProject = Object.fromEntries(buckets.map(b => [b.project || "(none)", b.output]));
  assert.deepEqual(byProject, { "~/ok/app": 15, "~/ok/lib": 20, "(none)": 1 });
  assert.equal(cells.length, 1);
  assert.equal(cells[0].output, 36, "the per-day cell is the sum over projects");
});

test("projects: false never records a path", () => {
  const root = project([entry({ cwd: "/Users/me/secret-client", requestId: "z", message: { id: "z", model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 3 } } })]);
  const { buckets } = readLogs({ roots: [root], projects: false, home: "/Users/me" });
  assert.deepEqual(buckets.map(b => b.project), [""]);
  assert.ok(!JSON.stringify(buckets).includes("secret-client"));
});

test("bucketsToProjectCells: day × project × model, costs summed, old days trimmed, null cost counts as 0", () => {
  const q = (y, m, d, h) => Math.floor(new Date(y, m - 1, d, h).getTime() / 900000);
  const b = (t, project, model, cost) => ({ t, project, model, input: 1, output: 1, cacheCreation: 1, cacheRead: 1, cost });
  const rows = bucketsToProjectCells([b(q(2026, 10, 8, 9), "~/a", "m1", 1), b(q(2026, 10, 8, 10), "~/a", "m1", 2), b(q(2026, 10, 8, 10), "~/b", "m1", null), b(q(2026, 9, 1, 10), "~/a", "m1", 9)], "2026-09-09");
  assert.deepEqual(rows.map(r => [r.date, r.project, r.model, r.cost, r.input]), [["2026-10-08", "~/a", "m1", 3, 2], ["2026-10-08", "~/b", "m1", 0, 1]]);
});
