import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadHistory, mergeBuckets, saveHistory } from "../lib/history.mjs";
import { bucketsToCells } from "../lib/logs.mjs";

const tmp = () => join(mkdtempSync(join(tmpdir(), "ccud-hist-")), "history.json");
const b = (t, model, input = 1, output = 2, cacheCreation = 3, cacheRead = 4, cost = null, project = "") => ({ t, project, model, input, output, cacheCreation, cacheCreation1h: 0, cacheRead, agent: "claude", cost });
// 1 USD per million tokens of every kind keeps the arithmetic in the tests obvious
const flat = rate => () => ({ input: rate, output: rate, cacheWrite: rate, cacheRead: rate });
const Q = 900000;
const quarter = d => Math.floor(d.getTime() / Q);

test("save → load round-trips, with a compact model table and no text fields", () => {
  const p = tmp();
  const data = [b(100, "claude-a", 1, 2, 3, 4, 0.25), b(101, "claude-b", 5, 6, 7, 8, null), b(102, "claude-a")];
  saveHistory(p, data, new Date("2026-10-08T12:00:00Z"));
  const raw = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(raw.models, ["claude-a", "claude-b"]);
  assert.equal(raw.rows.length, 3);
  assert.equal(raw.updatedAt, "2026-10-08T12:00:00.000Z");
  const back = loadHistory(p);
  assert.equal(back.status, "ok");
  assert.deepEqual(back.buckets, data);
  assert.deepEqual(Object.keys(raw).sort(), ["agents", "branches", "models", "note", "projects", "rows", "schema", "sessionRows", "sessions", "timeAll", "timeProjects", "updatedAt"], "only counts and names (plus session titles, see the sessions tests), no prompts");
  assert.deepEqual(raw.rows[0], [100, 0, 0, 1, 2, 3, 4, 0, 0, 0.25], "project, model, tokens, 1-hour cache writes, agent index, and the cost travels with the bucket");
  assert.deepEqual(raw.rows[1].at(-1), null, "no price known → null, not 0");
});

test("merge is a per-field maximum: cleanup can only shrink a bucket, activity can only grow it", () => {
  const ledger = [b(1, "m", 10, 500, 30, 40, 7), b(2, "m", 1, 1, 1, 1, 1)];
  const fresh = [b(1, "m", 12, 300, 30, 10), b(3, "m", 7, 7, 7, 7)];
  const { buckets, changed } = mergeBuckets(ledger, fresh, flat(1));
  assert.equal(changed, true);
  const t1 = buckets.find(x => x.t === 1);
  assert.deepEqual([t1.input, t1.output, t1.cacheCreation, t1.cacheRead], [12, 500, 30, 40], "max per field");
  assert.ok(buckets.find(x => x.t === 2), "a bucket missing from the logs (cleaned up) is kept");
  assert.ok(buckets.find(x => x.t === 3), "a new bucket is added");
  assert.equal(mergeBuckets(buckets, fresh, flat(1)).changed, false, "merging the same logs again changes nothing");
  assert.equal(mergeBuckets(buckets, [], flat(1)).changed, false);
});

test("cost is recorded at first sight and a later price change never rewrites it", () => {
  const tokens = { input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 };
  const august = mergeBuckets([], [{ t: 10, model: "m", ...tokens }], flat(100)); // $100 per M that month
  assert.equal(august.buckets[0].cost, 100);
  // September: the same tokens would cost 50 now. Same logs seen again, prices have dropped.
  const september = mergeBuckets(august.buckets, [{ t: 10, model: "m", ...tokens }], flat(50));
  assert.equal(september.changed, false);
  assert.equal(september.buckets[0].cost, 100, "what I actually spent stays what I actually spent");
  // …and once the transcript is gone from the logs entirely, the cost is still there
  assert.equal(mergeBuckets(september.buckets, [], flat(50)).buckets[0].cost, 100);
});

test("a bucket that grows is charged only for the growth, at today's rates", () => {
  const first = mergeBuckets([], [b(5, "m", 1_000_000, 0, 0, 0)], flat(100));
  assert.equal(first.buckets[0].cost, 100);
  const grown = mergeBuckets(first.buckets, [b(5, "m", 3_000_000, 0, 0, 0)], flat(50));
  assert.equal(grown.buckets[0].input, 3_000_000);
  assert.equal(grown.buckets[0].cost, 100 + 2 * 50, "old million at the old price, the two new millions at the new one");
});

test("a bucket recorded without a price (null) is priced once a price is known, and stays null until then", () => {
  const unpriced = mergeBuckets([], [b(1, "new-model", 1_000_000, 0, 0, 0)], () => null);
  assert.equal(unpriced.buckets[0].cost, null);
  assert.equal(mergeBuckets(unpriced.buckets, [], () => null).changed, false);
  const later = mergeBuckets(unpriced.buckets, [], flat(3));
  assert.equal(later.changed, true);
  assert.equal(later.buckets[0].cost, 3);
});

test("a rolling .bak of the previous state is kept; nothing is rewritten when nothing changed (caller's job)", () => {
  const p = tmp();
  saveHistory(p, [b(1, "m")]);
  assert.equal(existsSync(`${p}.bak`), false, "no backup for the very first write");
  saveHistory(p, [b(1, "m"), b(2, "m")]);
  assert.equal(JSON.parse(readFileSync(`${p}.bak`, "utf8")).rows.length, 1, "the backup is the previous state");
});

test("a corrupt or unexpected file is moved aside, not overwritten or lost", () => {
  const p = tmp();
  const logs = [];
  writeFileSync(p, "{ definitely not json");
  const r = loadHistory(p, m => logs.push(m));
  assert.equal(r.status, "quarantined");
  assert.deepEqual(r.buckets, []);
  assert.equal(existsSync(p), false);
  const aside = readdirSync(join(p, "..")).find(f => f.includes(".corrupt-"));
  assert.ok(aside, "the original is kept next to it");
  assert.equal(readFileSync(join(p, "..", aside), "utf8"), "{ definitely not json");
  assert.ok(logs.some(m => /unreadable \(not valid JSON\)/.test(m)));

  const p2 = tmp();
  writeFileSync(p2, JSON.stringify({ schema: 1, models: ["a"], rows: [[1, 7, 1, 1, 1, 1, 0]] })); // model index out of range
  assert.equal(loadHistory(p2).status, "quarantined");
});

test("a file from a NEWER version is readable but flagged, so callers never overwrite it", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ schema: 99, models: ["a"], projects: [""], rows: [[1, 0, 0, 1, 1, 1, 1, null]] }));
  const r = loadHistory(p, () => {});
  assert.equal(r.status, "newer");
  assert.equal(r.buckets.length, 1);
  assert.ok(existsSync(p));
});

test("local-day cells are derived from the buckets at read time", () => {
  const noon = quarter(new Date(2026, 9, 8, 12, 0));
  const late = quarter(new Date(2026, 9, 8, 23, 50));
  const next = quarter(new Date(2026, 9, 9, 0, 10));
  const cells = bucketsToCells([b(noon, "m", 1, 1, 1, 1), b(late, "m", 1, 1, 1, 1), b(next, "m", 2, 2, 2, 2)]);
  const byDay = Object.fromEntries(cells.map(c => [c.date, c.input]));
  assert.deepEqual(byDay, { "2026-10-08": 2, "2026-10-09": 2 });
});

test("changing the time zone does not double-count anything (the reason for UTC buckets)", () => {
  const instants = [new Date("2026-10-08T20:30:00Z"), new Date("2026-10-08T21:45:00Z"), new Date("2026-10-08T23:10:00Z"), new Date("2026-10-09T01:20:00Z")];
  const logs = instants.map(d => b(quarter(d), "m", 10, 10, 10, 10)); // the same entries, seen from both zones
  const old = process.env.TZ;
  try {
    process.env.TZ = "Europe/Kyiv";
    const ledger = mergeBuckets([], logs).buckets;              // recorded while living in Kyiv
    const daysKyiv = bucketsToCells(ledger).map(c => c.date).sort();
    process.env.TZ = "America/Los_Angeles";                     // …then travelling: same transcripts, other day boundaries
    const merged = mergeBuckets(ledger, logs);
    assert.equal(merged.changed, false, "identical instants never add anything");
    const totalLA = bucketsToCells(merged.buckets).reduce((s, c) => s + c.input, 0);
    assert.equal(totalLA, 40, "4 entries × 10 tokens, counted once");
    assert.notDeepEqual(bucketsToCells(merged.buckets).map(c => c.date).sort(), daysKyiv, "but the days are bucketed by the CURRENT zone");
  } finally {
    if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
  }
});

test("project is part of the bucket identity: same time and model in two projects are two rows, merged per project", () => {
  const a = b(5, "m", 10, 10, 10, 10, null, "~/a");
  const c = b(5, "m", 7, 7, 7, 7, null, "~/c");
  const first = mergeBuckets([], [a, c], flat(1));
  assert.equal(first.buckets.length, 2);
  const grown = mergeBuckets(first.buckets, [{ ...a, input: 20 }], flat(1));
  assert.equal(grown.buckets.find(x => x.project === "~/a").input, 20);
  assert.equal(grown.buckets.find(x => x.project === "~/c").input, 7, "the other project is untouched");
});

test("a schema 1 file (no projects) is read, flagged legacy and rewritten in the current schema", () => {
  const p = tmp();
  writeFileSync(p, JSON.stringify({ schema: 1, models: ["m"], rows: [[10, 0, 1, 2, 3, 4, 0.5]] }));
  const r = loadHistory(p);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.buckets, [{ t: 10, project: "", legacy: true, model: "m", input: 1, output: 2, cacheCreation: 3, cacheCreation1h: 0, cacheRead: 4, agent: "claude", cost: 0.5 }]);
  const merged = mergeBuckets(r.buckets, [], flat(1));
  assert.equal(merged.changed, true, "a surviving legacy row must be written back in the new format");
  assert.equal("legacy" in merged.buckets[0], false);
  saveHistory(p, merged.buckets);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).schema, 5);
  assert.equal(mergeBuckets(loadHistory(p).buckets, [], flat(1)).changed, false, "after the migration nothing is pending");
});

test("migration: a legacy row is replaced by project-attributed rows when the logs still cover it, and kept (as unattributed) when they do not", () => {
  const legacy = [{ t: 1, project: "", legacy: true, model: "m", input: 30, output: 30, cacheCreation: 0, cacheRead: 0, cost: 99 },
                  { t: 2, project: "", legacy: true, model: "m", input: 5, output: 5, cacheCreation: 0, cacheRead: 0, cost: 7 }];
  const fresh = [b(1, "m", 10, 10, 0, 0, null, "~/a"), b(1, "m", 20, 20, 0, 0, null, "~/b")]; // bucket 1 is still in the logs, bucket 2 was cleaned up
  const { buckets } = mergeBuckets(legacy, fresh, flat(1));
  const tokens = buckets.filter(x => x.t === 1).reduce((s, x) => s + x.input, 0);
  assert.equal(tokens, 30, "no double counting: the same 30 tokens, now split by project");
  assert.deepEqual(buckets.filter(x => x.t === 1).map(x => x.project).sort(), ["~/a", "~/b"]);
  const kept = buckets.find(x => x.t === 2);
  assert.deepEqual([kept.project, kept.cost], ["", 7], "history that only the old file knew stays, with its recorded cost");
});
