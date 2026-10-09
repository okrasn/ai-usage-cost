import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activeTime, readLogs } from "../lib/logs.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ccud-sess-"));
const at = (h, mi = 0, d = 8) => new Date(2026, 9, d, h, mi).toISOString(); // local time, so the date is the same in any zone
let n = 0;
// one assistant message; `over` is merged on top of the line (sessionId, gitBranch, isSidechain, cwd …), `usage` on top of the usage block
const msg = (over = {}, usage = {}) => {
  n++;
  return JSON.stringify({
    type: "assistant", timestamp: at(12), requestId: `r${n}`, sessionId: "S1", gitBranch: "main", cwd: "/home/u/app",
    message: { id: `m${n}`, model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, ...usage } },
    ...over,
  });
};
const note = o => JSON.stringify(o);
// several transcript files in one root: { "main.jsonl": [...lines], "p/subagents/agent-1.jsonl": [...] }
function logs(files) {
  const root = tmp();
  for (const [name, lines] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, lines.join("\n") + "\n");
  }
  return root;
}
const read = (files, opts = {}) => readLogs({ roots: [logs(files)], home: "/home/u", ...opts });
const row = (r, k) => r.sessionRows.find(x => `${x.session}|${x.branch}|${x.model}|${x.side}` === k);

test("sessions: tokens are grouped by session × branch × model × subagent flag, subagent work is kept apart", () => {
  const r = read({ "a.jsonl": [
    msg({ gitBranch: "main" }), msg({ gitBranch: "main" }),
    msg({ gitBranch: "feature/x" }),
    msg({ isSidechain: true }),
    msg({ sessionId: "S2" }),
    msg({}, {}), // second model below
  ], "b.jsonl": [JSON.stringify({ ...JSON.parse(msg({ gitBranch: "main" })), message: { id: "mm", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2 } } })] });
  const keys = r.sessionRows.map(x => `${x.session}|${x.branch}|${x.model}|${x.side}`).sort();
  assert.deepEqual(keys, ["S1|feature/x|claude-sonnet-5|0", "S1|main|claude-opus-5|0", "S1|main|claude-sonnet-5|0", "S1|main|claude-sonnet-5|1", "S2|main|claude-sonnet-5|0"]);
  assert.equal(row(r, "S1|main|claude-sonnet-5|0").input, 30, "three main-branch messages (one line has the default branch too)");
  assert.equal(row(r, "S1|main|claude-sonnet-5|1").output, 20, "the subagent's message");
  assert.equal(r.sessionRows.reduce((s, x) => s + x.output, 0), r.buckets.reduce((s, b) => s + b.output, 0), "session rows add up to the buckets");
});

test("sessions: thinking tokens and the 1-hour cache writes are carried, never above their totals", () => {
  const r = read({ "a.jsonl": [
    msg({}, { output_tokens: 100, output_tokens_details: { thinking_tokens: 45 }, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } }),
    msg({ sessionId: "S2" }, { output_tokens: 10, output_tokens_details: { thinking_tokens: 999 }, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 50 } }),
  ] });
  assert.equal(row(r, "S1|main|claude-sonnet-5|0").thinking, 45);
  assert.equal(row(r, "S1|main|claude-sonnet-5|0").cacheCreation1h, 20);
  assert.equal(row(r, "S2|main|claude-sonnet-5|0").thinking, 10, "cannot exceed the output tokens");
  assert.equal(row(r, "S2|main|claude-sonnet-5|0").cacheCreation1h, 5, "cannot exceed the cache writes");
  const b = r.buckets.find(x => x.cacheCreation1h > 0);
  assert.equal(b.cacheCreation1h, 25, "the buckets (what is priced) carry the 1-hour writes too");
  assert.equal(r.cells[0].cacheCreation1h, 25);
});

test("sessions: of a streamed duplicate the final entry decides branch, subagent flag and tokens", () => {
  const first = JSON.parse(msg({ gitBranch: "old" }, { output_tokens: 5 }));
  const last = { ...first, gitBranch: "final", message: { ...first.message, usage: { ...first.message.usage, output_tokens: 500 } } };
  const r = read({ "a.jsonl": [JSON.stringify(first), JSON.stringify(last)] });
  assert.deepEqual(r.sessionRows.map(x => [x.branch, x.output]), [["final", 500]]);
});

test("sessions: title — a title the user set beats the generated one, the last generated title wins, titles can be switched off", () => {
  const files = { "a.jsonl": [
    msg(), note({ type: "ai-title", sessionId: "S1", aiTitle: "First guess" }), note({ type: "ai-title", sessionId: "S1", aiTitle: "Better title" }),
    msg({ sessionId: "S2" }), note({ type: "ai-title", sessionId: "S2", aiTitle: "Generated" }), note({ type: "custom-title", sessionId: "S2", customTitle: "My name" }),
    msg({ sessionId: "S3" }),
  ] };
  const r = read(files);
  assert.deepEqual(r.sessions.map(s => [s.id, s.title]), [["S1", "Better title"], ["S2", "My name"], ["S3", ""]]);
  const off = read(files, { titles: false });
  assert.deepEqual(off.sessions.map(s => s.title), ["", "", ""], "no text-derived data when titles are off");
  assert.equal(off.sessionRows.length, 3, "the cost rows are untouched");
  assert.deepEqual(read(files, { time: false }).sessions.map(s => s.title), ["Better title", "My name", ""], "without active time the title and PR lines are still read");
});

test("sessions: pull requests are collected once per repo#number and sorted; junk entries are ignored", () => {
  const r = read({ "a.jsonl": [
    msg(),
    note({ type: "pr-link", sessionId: "S1", prNumber: 12, prRepository: "acme/web", prUrl: "https://github.com/acme/web/pull/12" }),
    note({ type: "pr-link", sessionId: "S1", prNumber: 12, prRepository: "acme/web", prUrl: "https://github.com/acme/web/pull/12" }),
    note({ type: "pr-link", sessionId: "S1", prNumber: 3, prRepository: "acme/web" }),
    note({ type: "pr-link", sessionId: "S1", prNumber: 7, prRepository: "acme/api" }),
    note({ type: "pr-link", sessionId: "S1", prNumber: "x", prRepository: "acme/bad" }),
    note({ type: "pr-link", sessionId: "S1", prNumber: 9 }),
  ] });
  assert.deepEqual(r.sessions[0].prs.map(p => [...p]), [["acme/api", 7], ["acme/web", 3], ["acme/web", 12]]);
});

test("sessions: project = where most of its messages were written, first/last message time, session without a project name when projects are off", () => {
  const r = read({ "a.jsonl": [
    msg({ cwd: "/home/u/a", timestamp: at(9) }), msg({ cwd: "/home/u/b", timestamp: at(10) }), msg({ cwd: "/home/u/b", timestamp: at(11, 30) }),
    msg({ sessionId: "T", cwd: "/home/u/z", timestamp: at(8) }), msg({ sessionId: "T", cwd: "/home/u/y", timestamp: at(9) }),
  ] });
  const s1 = r.sessions.find(s => s.id === "S1");
  assert.equal(s1.project, "~/b");
  assert.equal(s1.t0, new Date(at(9)).getTime());
  assert.equal(s1.t1, new Date(at(11, 30)).getTime());
  assert.equal(r.sessions.find(s => s.id === "T").project, "~/y", "a tie goes to the alphabetically first project");
  assert.deepEqual(r.sessions.map(s => s.id), ["T", "S1"], "ordered by first message");
  assert.deepEqual(read({ "a.jsonl": [msg()] }, { projects: false }).sessions.map(s => s.project), [""]);
});

test("sessions: active seconds are the union over the session's files (main + subagents); other sessions do not mix in", () => {
  const r = read({
    "S1.jsonl": [msg({ timestamp: at(10, 0) }), msg({ timestamp: at(10, 5) }), msg({ timestamp: at(10, 9) })],
    "S1/subagents/agent-a.jsonl": [msg({ timestamp: at(10, 3), isSidechain: true }), msg({ timestamp: at(10, 8), isSidechain: true })],
    "S2.jsonl": [msg({ sessionId: "S2", timestamp: at(10, 0) }), msg({ sessionId: "S2", timestamp: at(10, 2) })],
  });
  const secs = Object.fromEntries(r.sessions.map(s => [s.id, s.seconds]));
  assert.deepEqual(secs, { S1: 9 * 60, S2: 2 * 60 }, "0–9 min from the main file; the subagent's 3–8 overlaps and counts once");
  assert.equal(read({ "a.jsonl": [msg(), msg({ timestamp: at(12, 5) })] }, { time: false }).sessions[0].seconds, 0, "time off: no seconds");
});

test("activeTime: per-session seconds ignore events without a session id and gaps over the threshold", () => {
  const MIN = 60000, T0 = new Date(2026, 9, 8, 10).getTime();
  const e = (min, sid) => ({ ms: T0 + min * MIN, project: "~/a", sid });
  const t = activeTime([[e(0, "A"), e(5, "A"), e(30, "A")], [e(0, ""), e(4, "")]], 10);
  assert.deepEqual([...t.sessions], [["A", 300]]);
});

test("sessions off: nothing is collected or returned, title lines are not even parsed", () => {
  const r = read({ "a.jsonl": [msg(), note({ type: "ai-title", sessionId: "S1", aiTitle: "T" })] }, { sessions: false, time: false });
  assert.equal(r.sessions, null);
  assert.equal(r.sessionRows, null);
  assert.equal(r.time, null);
  assert.equal(r.buckets.length, 1, "the usage is still read");
});

test("sessions: a message without sessionId inherits the one seen earlier in the file, otherwise it is the empty session", () => {
  const bare = JSON.parse(msg()); delete bare.sessionId;
  const r1 = read({ "a.jsonl": [msg({ sessionId: "S9" }), JSON.stringify(bare)] });
  assert.deepEqual(r1.sessionRows.map(x => x.session), ["S9"]);
  const r2 = read({ "a.jsonl": [JSON.stringify(bare)] });
  assert.deepEqual(r2.sessionRows.map(x => x.session), [""]);
});
