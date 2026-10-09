import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA, loadHistory, mergeBuckets, mergeSessionRows, mergeSessions, saveHistory } from "../lib/history.mjs";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ccud-hs-")), "history.json");
const P = { input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2 };
const price = () => P;
const none = () => null;
const bucket = (t, over = {}) => ({ t, project: "~/a", model: "claude-sonnet-5", input: 0, output: 0, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, agent: "claude", ...over });
const srow = (over = {}) => ({ session: "S1", agent: "claude", branch: "main", model: "claude-sonnet-5", side: 0, input: 0, output: 0, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0, thinking: 0, ...over });
const session = (over = {}) => ({ id: "S1", agent: "claude", title: "T", project: "~/a", t0: 1000, t1: 2000, seconds: 60, prs: [], ...over });

test("schema 5: sessions, branches and session rows survive a save → load round trip (subagent flag, PRs, thinking, cost, null cost)", () => {
  const p = tmp();
  const sessions = [session({ id: "S1", title: "Fix the thing", prs: [["acme/web", 12], ["acme/api", 3]] }), session({ id: "S2", title: "", project: "", t0: 3000, t1: 4000, seconds: 0 })];
  const rows = [srow({ input: 1, output: 2, cacheCreation: 3, cacheCreation1h: 2, cacheRead: 4, thinking: 1, cost: 0.5 }), srow({ side: 1, branch: "feature/x", cost: null }), srow({ session: "S2", model: "claude-opus-5", cost: 1 })];
  saveHistory(p, [bucket(100, { input: 1, cost: 0.1 })], new Date("2026-10-09T10:00:00Z"), undefined, { sessions, sessionRows: rows });
  const raw = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(raw.schema, SCHEMA);
  assert.deepEqual(raw.branches, ["feature/x", "main"]);
  assert.deepEqual(raw.models, ["claude-opus-5", "claude-sonnet-5"]);
  assert.deepEqual(raw.sessions[0], ["S1", "Fix the thing", raw.projects.indexOf("~/a"), 1000, 2000, 60, [["acme/web", 12], ["acme/api", 3]], 0], "the last column is the agent index");
  assert.equal(raw.sessionRows.length, 3);
  assert.deepEqual(raw.sessionRows[0], [0, 1, 1, 0, 1, 2, 3, 2, 4, 1, 0.5], "session, branch, model indexes, subagent flag, tokens, 1h writes, thinking, cost");
  const back = loadHistory(p);
  assert.equal(back.status, "ok");
  assert.deepEqual(back.sessions, sessions);
  assert.deepEqual(back.sessionRows.map(r => [r.session, r.branch, r.model, r.side, r.cost]).sort(), rows.map(r => [r.session, r.branch, r.model, r.side, r.cost]).sort());
  assert.deepEqual(back.sessionRows.find(r => r.thinking === 1), rows[0]);
});

test("schema 5: bucket rows carry the 1-hour cache writes and the agent in their own columns", () => {
  const p = tmp();
  saveHistory(p, [bucket(100, { cacheCreation: 5, cacheCreation1h: 3, cost: 0.25 })]);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).rows[0], [100, 0, 0, 0, 0, 5, 0, 3, 0, 0.25]);
  assert.equal(loadHistory(p).buckets[0].cacheCreation1h, 3);
});

test("a schema 3 file (8-column rows, no sessions) is read as is and rewritten as schema 5 without changing a recorded cost", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ schema: 3, updatedAt: "x", models: ["claude-sonnet-5"], projects: ["~/a"], rows: [[100, 0, 0, 1, 2, 3, 4, 0.75]], timeProjects: [[100, 0, 60]], timeAll: [[100, 60]] }));
  const r = loadHistory(p);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.buckets, [{ t: 100, project: "~/a", model: "claude-sonnet-5", input: 1, output: 2, cacheCreation: 3, cacheCreation1h: 0, cacheRead: 4, agent: "claude", cost: 0.75 }]);
  assert.deepEqual([r.sessions, r.sessionRows], [[], []]);
  assert.deepEqual(r.time.all, [{ t: 100, seconds: 60, agent: "claude" }], "active time is kept");
  const m = mergeBuckets(r.buckets, [], price);
  assert.equal(m.changed, false);
  saveHistory(p, m.buckets, new Date(), r.time);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).schema, 5);
  assert.equal(loadHistory(p).buckets[0].cost, 0.75);
});

test("a 1-hour cache write is priced at the 1-hour rate when the bucket is first seen; later growth only prices the growth", () => {
  const first = mergeBuckets([], [bucket(1, { cacheCreation: 1e6, cacheCreation1h: 1e6 })], price);
  assert.equal(first.buckets[0].cost, 4, "1M tokens in the 1-hour cache: $4, not $2.50");
  const grown = mergeBuckets(first.buckets, [bucket(1, { cacheCreation: 3e6, cacheCreation1h: 1e6 })], price);
  assert.equal(grown.buckets[0].cost, 4 + 2 * 2.5, "2M more writes, all 5-minute: $5 added to the $4 already recorded");
  assert.equal(grown.buckets[0].cacheCreation1h, 1e6);
});

test("tokens that a schema 3 row did not know were 1-hour writes are recorded, but its recorded cost is never repriced", () => {
  const old = [bucket(1, { cacheCreation: 1e6, cost: 2.5 })]; // priced when only the 5-minute rate was applied
  const r = mergeBuckets(old, [bucket(1, { cacheCreation: 1e6, cacheCreation1h: 1e6 })], price);
  assert.equal(r.buckets[0].cost, 2.5);
  assert.equal(r.buckets[0].cacheCreation1h, 1e6);
  assert.equal(r.changed, true, "the new detail is written back");
});

test("session rows: priced when first seen, only growth priced later, shrinking logs change nothing, a missing price is filled in later", () => {
  const a = mergeSessionRows([], [srow({ input: 1e6, output: 1e6 })], price);
  assert.equal(a.rows[0].cost, 12);
  assert.equal(a.changed, true);
  const grown = mergeSessionRows(a.rows, [srow({ input: 1e6, output: 2e6 })], () => ({ ...P, output: 20 }));
  assert.equal(grown.rows[0].cost, 12 + 20, "the extra million output tokens at today's (changed) rate; the first $12 stay");
  const thinking = mergeSessionRows(mergeSessionRows([], [srow({ output: 10, thinking: 5 })], price).rows, [srow({ output: 20, thinking: 9 })], price);
  assert.equal(thinking.rows[0].thinking, 9, "thinking tokens grow with the row");
  assert.equal(mergeSessionRows(thinking.rows, [srow({ output: 20, thinking: 3 })], price).rows[0].thinking, 9, "and never shrink");
  const shrunk = mergeSessionRows(grown.rows, [srow({ input: 5, output: 5 })], price);
  assert.equal(shrunk.changed, false);
  assert.equal(shrunk.rows[0].output, 2e6, "cleanup of the logs cannot shrink the ledger");
  const unpriced = mergeSessionRows([], [srow({ input: 1e6 })], none);
  assert.equal(unpriced.rows[0].cost, null);
  assert.equal(mergeSessionRows(unpriced.rows, [], price).rows[0].cost, 2, "priced as soon as a price exists");
});

test("session rows: main and subagent work, other branches and other models are separate rows", () => {
  const r = mergeSessionRows([], [srow({ input: 1 }), srow({ side: 1, input: 2 }), srow({ branch: "b", input: 3 }), srow({ model: "claude-opus-5", input: 4 }), srow({ session: "S2", input: 5 })], price);
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows.map(x => x.input), [3, 4, 1, 2, 5], "sorted by session, branch, model, subagent flag");
  assert.equal(r.rows.reduce((s, x) => s + x.input, 0), 15);
  const again = mergeSessionRows(r.rows, [srow({ input: 1 }), srow({ side: 1, input: 2 })], price);
  assert.equal(again.changed, false, "the same data again changes nothing");
});

test("sessions: the newest non-empty title wins, the span only widens, active time takes the maximum, pull requests are united", () => {
  const ledger = [session({ title: "Old", t0: 1000, t1: 2000, seconds: 60, prs: [["a/b", 1]] })];
  const r = mergeSessions(ledger, [session({ title: "New", t0: 1500, t1: 2500, seconds: 30, prs: [["a/b", 1], ["a/b", 2]] })]);
  assert.deepEqual(r.sessions, [session({ title: "New", t0: 1000, t1: 2500, seconds: 60, prs: [["a/b", 1], ["a/b", 2]] })]);
  assert.equal(r.changed, true);
  const keepsTitle = mergeSessions(r.sessions, [session({ title: "", t0: 1000, t1: 2500, seconds: 60, prs: [] })]);
  assert.equal(keepsTitle.sessions[0].title, "New", "an empty title (titles switched off, or none generated) never erases one");
  assert.equal(keepsTitle.sessions[0].prs.length, 2);
  assert.equal(keepsTitle.changed, false);
  const noProject = mergeSessions(ledger, [session({ project: "" })]);
  assert.equal(noProject.sessions[0].project, "~/a");
  const added = mergeSessions(ledger, [session({ id: "S0", t0: 1 })]);
  assert.deepEqual(added.sessions.map(s => s.id), ["S0", "S1"], "ordered by first message");
});

test("a damaged sessions table quarantines the file instead of being trusted; a newer schema stays read-only", () => {
  const p = tmp();
  // models and branches are fine; the only defect is a session row that points at a session that does not exist
  writeFileSync(p, JSON.stringify({ schema: 4, models: ["m"], projects: [""], branches: ["b"], rows: [], timeProjects: [], timeAll: [], sessions: [], sessionRows: [[7, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0.1]] }));
  const logs = [];
  const r = loadHistory(p, m => logs.push(m));
  assert.equal(r.status, "quarantined");
  assert.deepEqual(r.sessions, []);
  assert.ok(readdirSync(join(p, "..")).some(f => f.startsWith("history.json.corrupt-")));
  assert.equal(existsSync(p), false);
  const q = tmp();
  writeFileSync(q, JSON.stringify({ schema: 99, models: ["m"], projects: [""], branches: ["b"], rows: [], sessions: [["S", "t", 0, 1, 2, 3, []]], sessionRows: [[0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0.1]], timeProjects: [], timeAll: [] }));
  const newer = loadHistory(q);
  assert.equal(newer.status, "newer");
  assert.equal(newer.sessions.length, 1, "what can be read is used");
});

test("saving drops session rows whose session is unknown instead of writing a file that cannot be read back", () => {
  const p = tmp();
  saveHistory(p, [], new Date(), undefined, { sessions: [session({ id: "S1" })], sessionRows: [srow({ session: "S1", input: 1, cost: 1 }), srow({ session: "GHOST", input: 2, cost: 1 })] });
  const back = loadHistory(p);
  assert.equal(back.status, "ok");
  assert.deepEqual(back.sessionRows.map(r => r.session), ["S1"]);
});
