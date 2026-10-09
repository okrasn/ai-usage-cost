import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.mjs";

const write = obj => {
  const p = join(mkdtempSync(join(tmpdir(), "ccud-cfg-")), "config.json");
  writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
  return p;
};

test("defaults when the file is absent; user values merge over them", () => {
  assert.deepEqual(loadConfig("/nonexistent"), { weekStart: "auto", source: "auto", agents: "auto", prices: {}, priceRefresh: "daily", priceUrl: null, history: "on", projects: "on", time: "on", sessions: "on", sessionTitles: "on", idleMinutes: 10 });
  assert.equal(loadConfig(write({ source: "ccusage" })).source, "ccusage");
});

test("rejects bad source, bad prices and malformed JSON with a message that names the problem", () => {
  assert.throws(() => loadConfig(write({ source: "magic" })), /"source" must be one of auto, logs, ccusage/);
  assert.throws(() => loadConfig(write({ prices: [] })), /"prices" must be an object/);
  assert.throws(() => loadConfig(write({ prices: { m: { input: 1, output: 2, cacheWrite: 3 } } })), /prices\["m"\] needs non-negative numbers/);
  assert.throws(() => loadConfig(write({ prices: { m: { input: -1, output: 2, cacheWrite: 3, cacheRead: 4 } } })), /prices\["m"\]/);
  assert.throws(() => loadConfig(write({ priceRefresh: "hourly" })), /"priceRefresh" must be "daily" or "off"/);
  assert.throws(() => loadConfig(write({ history: "maybe" })), /"history" must be "on" or "off"/);
  assert.throws(() => loadConfig(write({ projects: 1 })), /"projects" must be "on" or "off"/);
  assert.throws(() => loadConfig(write({ time: "yes" })), /"time" must be "on" or "off"/);
  assert.throws(() => loadConfig(write({ idleMinutes: 0 })), /"idleMinutes" must be a number between 1 and 240/);
  assert.throws(() => loadConfig(write({ idleMinutes: "10" })), /"idleMinutes"/);
  assert.equal(loadConfig(write({ idleMinutes: 30 })).idleMinutes, 30);
  assert.throws(() => loadConfig(write({ priceUrl: "ftp://x" })), /"priceUrl" must be an http\(s\) URL/);
  assert.equal(loadConfig(write({ priceRefresh: "off", priceUrl: "https://mirror.example/prices.json" })).priceRefresh, "off");
  assert.throws(() => loadConfig(write("{nope")), /not valid JSON/);
  assert.doesNotThrow(() => loadConfig(write({ prices: { m: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } } })));
});

test("sessions and sessionTitles accept only on / off", () => {
  assert.equal(loadConfig(write({ sessions: "off" })).sessions, "off");
  assert.equal(loadConfig(write({ sessionTitles: "off" })).sessionTitles, "off");
  assert.throws(() => loadConfig(write({ sessions: "yes" })), /"sessions" must be "on" or "off"/);
  assert.throws(() => loadConfig(write({ sessionTitles: true })), /"sessionTitles" must be "on" or "off"/);
});
