import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA, loadHistory, mergeBuckets, mergeSessionRows, mergeSessions, mergeTime, saveHistory } from "../lib/history.mjs";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ccud-ha-")), "history.json");
const P = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };
const bucket = (agent, t, over = {}) => ({ t, agent, project: "~/a", model: agent === "claude" ? "claude-sonnet-5" : "gemini-x", input: 1, output: 2, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, cost: 0.5, ...over });
const session = (agent, id, over = {}) => ({ id, agent, title: `T ${agent}`, project: "~/a", t0: 1, t1: 2, seconds: 3, prs: [], ...over });
const srow = (agent, session, over = {}) => ({ session, agent, branch: "main", model: agent === "claude" ? "claude-sonnet-5" : "gemini-x", side: 0, input: 1, output: 1, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, thinking: 0, cost: 1, ...over });

test("schema 5: two agents round-trip side by side, with the agent as an index into a sorted pool", () => {
  const p = tmp();
  const buckets = [bucket("gemini", 5), bucket("claude", 5), bucket("claude", 6)];
  const time = { projects: [{ t: 5, project: "~/a", seconds: 60, agent: "gemini" }, { t: 5, project: "~/a", seconds: 30, agent: "claude" }], all: [{ t: 5, seconds: 60, agent: "gemini" }, { t: 5, seconds: 30, agent: "claude" }] };
  const sessions = [session("claude", "S1"), session("gemini", "G1")];
  const sessionRows = [srow("claude", "S1"), srow("gemini", "G1")];
  saveHistory(p, buckets, new Date("2026-10-09T10:00:00Z"), time, { sessions, sessionRows });
  const raw = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(raw.schema, SCHEMA);
  assert.deepEqual(raw.agents, ["claude", "gemini"]);
  assert.deepEqual(raw.rows.map(r => r.at(-2)), [1, 0, 0], "the agent index sits right before the cost");
  assert.deepEqual(raw.timeProjects.map(r => r[3]), [1, 0]);
  assert.deepEqual(raw.timeAll.map(r => r[2]), [1, 0]);
  assert.deepEqual(raw.sessions.map(r => r[7]), [0, 1]);
  const back = loadHistory(p);
  assert.equal(back.status, "ok");
  const by = (rows, a) => rows.filter(r => r.agent === a);
  assert.equal(by(back.buckets, "claude").length, 2);
  assert.equal(by(back.buckets, "gemini").length, 1);
  assert.deepEqual(by(back.time.all, "gemini").map(r => r.seconds), [60]);
  assert.deepEqual(back.sessions.map(s => [s.agent, s.id]).sort(), [["claude", "S1"], ["gemini", "G1"]]);
  assert.deepEqual(back.sessionRows.map(r => [r.agent, r.session]).sort(), [["claude", "S1"], ["gemini", "G1"]], "a session row finds its session and inherits its agent");
});

test("the same session id in two agents is two sessions: rows attach to the right one", () => {
  const p = tmp();
  const sessions = [session("claude", "same", { title: "Claude's" }), session("gemini", "same", { title: "Gemini's" })];
  const sessionRows = [srow("claude", "same", { cost: 1 }), srow("gemini", "same", { cost: 7 })];
  saveHistory(p, [], new Date(), undefined, { sessions, sessionRows });
  const back = loadHistory(p);
  assert.deepEqual(back.sessions.map(s => [s.agent, s.title]).sort(), [["claude", "Claude's"], ["gemini", "Gemini's"]]);
  assert.deepEqual(back.sessionRows.map(r => [r.agent, r.cost]).sort(), [["claude", 1], ["gemini", 7]]);
});

test("rows without an agent are saved as 'claude' (what every older caller meant)", () => {
  const p = tmp();
  saveHistory(p, [{ t: 1, project: "", model: "m", input: 1, output: 1, cacheCreation: 0, cacheRead: 0, cost: 1 }], new Date(), { projects: [], all: [{ t: 1, seconds: 5 }] });
  const raw = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(raw.agents, ["claude"]);
  assert.equal(loadHistory(p).buckets[0].agent, "claude");
});

test("older files (schema 2, 3, 4) are read as agent 'claude' in every table", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ schema: 4, models: ["claude-sonnet-5"], projects: ["~/a"], branches: ["main"], rows: [[10, 0, 0, 1, 2, 3, 4, 0, 0.5]], timeProjects: [[10, 0, 60]], timeAll: [[10, 60]], sessions: [["S1", "T", 0, 1, 2, 3, []]], sessionRows: [[0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0.5]] }));
  const r = loadHistory(p);
  assert.equal(r.status, "ok");
  assert.deepEqual([r.buckets[0].agent, r.time.projects[0].agent, r.time.all[0].agent, r.sessions[0].agent, r.sessionRows[0].agent], ["claude", "claude", "claude", "claude", "claude"]);
  writeFileSync(p, JSON.stringify({ schema: 2, models: ["m"], projects: [""], rows: [[1, 0, 0, 1, 1, 1, 1, 0.5]] }));
  assert.equal(loadHistory(p).buckets[0].agent, "claude");
});

test("a broken agent index quarantines the file instead of guessing (buckets, time, sessions)", () => {
  const base = { schema: 5, agents: ["claude"], models: ["m"], projects: [""], branches: ["b"], rows: [], timeProjects: [], timeAll: [], sessions: [], sessionRows: [] };
  for (const [what, patch] of [
    ["bucket", { rows: [[1, 0, 0, 1, 1, 1, 1, 0, 9, 0.5]] }],
    ["time project", { timeProjects: [[1, 0, 5, 9]] }],
    ["time total", { timeAll: [[1, 5, 9]] }],
    ["session", { sessions: [["S", "t", 0, 1, 2, 3, [], 9]] }],
  ]) {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ ...base, ...patch }));
    assert.equal(loadHistory(p, () => {}).status, "quarantined", what);
    assert.equal(existsSync(p), false, `${what}: moved aside, not overwritten`);
  }
  const p = tmp();
  writeFileSync(p, JSON.stringify({ ...base, agents: undefined, rows: [[1, 0, 0, 1, 1, 1, 1, 0, 0, 0.5]] }));
  assert.equal(loadHistory(p, () => {}).status, "quarantined", "a schema 5 row without an agent pool");
});

test("an agent that this version does not know is still loaded and saved back untouched (history outlives the registry)", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ schema: 5, agents: ["claude", "someday-tool"], models: ["x"], projects: [""], branches: [], rows: [[1, 0, 0, 1, 1, 0, 0, 0, 1, 0.5]], timeProjects: [], timeAll: [], sessions: [], sessionRows: [] }));
  const r = loadHistory(p);
  assert.equal(r.status, "ok");
  assert.equal(r.buckets[0].agent, "someday-tool");
  saveHistory(p, r.buckets, new Date(), r.time, r);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).agents, ["someday-tool"]);
});

test("the merge functions keep the agent of what they merge: new rows, grown rows, sessions, time", () => {
  const price = () => P;
  const g = mergeBuckets([bucket("gemini", 1, { input: 1, cost: 0.1 })], [bucket("gemini", 1, { input: 5, cost: undefined }), bucket("gemini", 2, { cost: undefined })], price);
  assert.deepEqual(g.buckets.map(b => b.agent), ["gemini", "gemini"]);
  const sr = mergeSessionRows([srow("gemini", "G1", { input: 1 })], [srow("gemini", "G1", { input: 4, cost: undefined })], price);
  assert.equal(sr.rows[0].agent, "gemini");
  const ss = mergeSessions([session("gemini", "G1", { seconds: 1 })], [session("gemini", "G1", { seconds: 9 })]);
  assert.equal(ss.sessions[0].agent, "gemini", "an updated session keeps its agent");
  assert.equal(ss.sessions[0].seconds, 9);
  const tm = mergeTime({ projects: [], all: [{ t: 1, seconds: 5, agent: "gemini" }] }, { projects: [], all: [{ t: 1, seconds: 8, agent: "gemini" }] });
  assert.deepEqual(tm.time.all, [{ t: 1, seconds: 8, agent: "gemini" }]);
});
