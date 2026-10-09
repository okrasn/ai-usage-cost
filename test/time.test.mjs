import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_TIME, loadHistory, mergeTime, saveHistory } from "../lib/history.mjs";
import { activeTime, bucketDate, readLogs } from "../lib/logs.mjs";

const MIN = 60000;
const T0 = new Date(2026, 9, 8, 10, 0, 0).getTime(); // 10:00 local, on a 15-minute boundary
const ev = (min, project = "~/a") => ({ ms: T0 + min * MIN, project });
const total = rows => rows.reduce((s, r) => s + r.seconds, 0);

test("active time: gaps up to the idle threshold count, longer gaps are time away", () => {
  const t = activeTime([[ev(0), ev(3), ev(5), ev(30), ev(33)]], 10);   // 0→3→5 (5 min) , 5→30 away, 30→33 (3 min)
  assert.equal(total(t.all), 8 * 60);
  assert.equal(total(t.projects), 8 * 60);
  assert.equal(total(activeTime([[ev(0), ev(10)]], 10).all), 10 * 60, "a gap equal to the threshold counts");
  assert.equal(total(activeTime([[ev(0), ev(11)]], 10).all), 0, "one minute over does not");
  assert.equal(total(activeTime([[ev(0), ev(11)]], 15).all), 11 * 60, "the threshold is configurable");
  assert.deepEqual(activeTime([[ev(0)]], 10), { projects: [], all: [] }, "a single event has no duration");
  assert.deepEqual(activeTime([], 10), { projects: [], all: [] });
});

test("parallel sessions in one project count once; in two projects each counts it, but the overall total counts it once", () => {
  const same = activeTime([[ev(0), ev(10)], [ev(5), ev(15)]], 10);   // 0–10 and 5–15 overlap → 15 minutes
  assert.equal(total(same.projects), 15 * 60);
  assert.equal(total(same.all), 15 * 60);
  const apart = activeTime([[ev(0, "~/a"), ev(10, "~/a")], [ev(0, "~/b"), ev(10, "~/b")]], 10);
  assert.equal(total(apart.projects), 20 * 60, "10 min in a + 10 min in b");
  assert.equal(total(apart.all), 10 * 60, "…but you only worked 10 minutes");
});

test("a gap belongs to the project the session was in when it began; unsorted events are fine", () => {
  const t = activeTime([[ev(8, "~/b"), ev(0, "~/a"), ev(4, "~/a")]], 10);   // 0→4 in a, 4→8 in a (event at 4 is in a), the 8 is b
  const sums = {};
  for (const r of t.projects) sums[r.project] = (sums[r.project] ?? 0) + r.seconds;
  assert.deepEqual(sums, { "~/a": 8 * 60 });
});

test("seconds are split over the 15-minute buckets they fall into", () => {
  const t = activeTime([[ev(10), ev(18), ev(25)]], 10); // 10:10–10:25 crosses 10:15
  const q = Math.floor(T0 / 900000);
  assert.deepEqual(t.all.map(r => [r.t - q, r.seconds]), [[0, 300], [1, 600]], "5 minutes before 10:15, 10 minutes after");
  assert.equal(total(t.all), 15 * 60);
  assert.equal(bucketDate(q), "2026-10-08");
});

test("readLogs: reads every timestamped line, carries the working folder forward, and keeps no text", () => {
  const root = mkdtempSync(join(tmpdir(), "ccud-time-"));
  mkdirSync(join(root, "p"), { recursive: true });
  const at = min => new Date(T0 + min * MIN).toISOString();
  const lines = [
    { type: "user", timestamp: at(0), cwd: "/Users/me/ok/app", message: { content: "SECRET PROMPT" } },
    { type: "attachment", timestamp: at(2) },                       // no cwd of its own → the folder carries forward
    { type: "assistant", timestamp: at(4), requestId: "r", message: { id: "m", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "user", timestamp: at(40), cwd: "/Users/me/ok/lib" },    // 36 minutes later: away
    { type: "user", timestamp: at(43) },
  ].map(o => JSON.stringify(o));
  writeFileSync(join(root, "p", "s.jsonl"), lines.join("\n") + "\n");
  const r = readLogs({ roots: [root], home: "/Users/me", idleMinutes: 10 });
  const sums = {};
  for (const x of r.time.projects) sums[x.project] = (sums[x.project] ?? 0) + x.seconds;
  assert.deepEqual(sums, { "~/ok/app": 4 * 60, "~/ok/lib": 3 * 60 });
  assert.equal(total(r.time.all), 7 * 60);
  assert.ok(!JSON.stringify(r.time).includes("SECRET"));
  assert.equal(r.buckets.length, 1, "tokens still work next to time");
  const off = readLogs({ roots: [root], home: "/Users/me", time: false });
  assert.equal(off.time, null);
  const noProjects = readLogs({ roots: [root], projects: false, home: "/Users/me" });
  assert.deepEqual([...new Set(noProjects.time.projects.map(x => x.project))], [""]);
  assert.equal(total(noProjects.time.all), 7 * 60);
});

test("two transcript files that overlap (a session and its sub-agent) are united", () => {
  const root = mkdtempSync(join(tmpdir(), "ccud-time2-"));
  mkdirSync(join(root, "p"), { recursive: true });
  const at = min => new Date(T0 + min * MIN).toISOString();
  const file = (name, mins) => writeFileSync(join(root, "p", name), mins.map(m => JSON.stringify({ type: "user", timestamp: at(m), cwd: "/srv/x" })).join("\n") + "\n");
  file("a.jsonl", [0, 6, 12]);
  file("b.jsonl", [3, 9, 15]);
  const r = readLogs({ roots: [root], home: "/nope" });
  assert.equal(total(r.time.all), 15 * 60, "0→12 and 3→15 overlap into 15 minutes, not 24");
});

test("history: time is kept with a per-field maximum, survives a save/load, and older schemas load with no time", () => {
  const ledger = { projects: [{ t: 1, project: "~/a", seconds: 600 }], all: [{ t: 1, seconds: 600 }] };
  const fresh = { projects: [{ t: 1, project: "~/a", seconds: 400 }, { t: 2, project: "~/a", seconds: 100 }], all: [{ t: 1, seconds: 500 }, { t: 2, seconds: 100 }] };
  const m = mergeTime(ledger, fresh);
  assert.equal(m.changed, true);
  assert.deepEqual(m.time.projects.map(r => [r.t, r.seconds]), [[1, 600], [2, 100]], "bucket 1 keeps the larger value (the logs were partly cleaned up)");
  assert.equal(mergeTime(m.time, fresh).changed, false);
  assert.equal(mergeTime(ledger, EMPTY_TIME).changed, false);

  const p = join(mkdtempSync(join(tmpdir(), "ccud-th-")), "history.json");
  saveHistory(p, [], new Date(), m.time);
  const back = loadHistory(p);
  assert.equal(back.status, "ok");
  assert.deepEqual(back.time, m.time);

  writeFileSync(p, JSON.stringify({ schema: 2, models: ["m"], projects: [""], rows: [[1, 0, 0, 1, 1, 1, 1, 0.5]] }));
  const v2 = loadHistory(p);
  assert.equal(v2.status, "ok");
  assert.deepEqual(v2.time, EMPTY_TIME);
  assert.equal(v2.buckets.length, 1);
});

test("history: a malformed time section is treated as an unreadable file, not silently dropped", () => {
  const p = join(mkdtempSync(join(tmpdir(), "ccud-tb-")), "history.json");
  writeFileSync(p, JSON.stringify({ schema: 3, models: [], projects: [""], rows: [], timeProjects: [[1, 9, 5]], timeAll: [] }));
  assert.equal(loadHistory(p).status, "quarantined");
});
