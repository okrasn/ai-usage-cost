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
  assert.deepEqual(loadConfig("/nonexistent"), { weekStart: "auto", source: "auto", prices: {}, priceRefresh: "daily", priceUrl: null, history: "on" });
  assert.equal(loadConfig(write({ source: "ccusage" })).source, "ccusage");
});

test("rejects bad source, bad prices and malformed JSON with a message that names the problem", () => {
  assert.throws(() => loadConfig(write({ source: "magic" })), /"source" must be one of auto, logs, ccusage/);
  assert.throws(() => loadConfig(write({ prices: [] })), /"prices" must be an object/);
  assert.throws(() => loadConfig(write({ prices: { m: { input: 1, output: 2, cacheWrite: 3 } } })), /prices\["m"\] needs non-negative numbers/);
  assert.throws(() => loadConfig(write({ prices: { m: { input: -1, output: 2, cacheWrite: 3, cacheRead: 4 } } })), /prices\["m"\]/);
  assert.throws(() => loadConfig(write({ priceRefresh: "hourly" })), /"priceRefresh" must be "daily" or "off"/);
  assert.throws(() => loadConfig(write({ history: "maybe" })), /"history" must be "on" or "off"/);
  assert.throws(() => loadConfig(write({ priceUrl: "ftp://x" })), /"priceUrl" must be an http\(s\) URL/);
  assert.equal(loadConfig(write({ priceRefresh: "off", priceUrl: "https://mirror.example/prices.json" })).priceRefresh, "off");
  assert.throws(() => loadConfig(write("{nope")), /not valid JSON/);
  assert.doesNotThrow(() => loadConfig(write({ prices: { m: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } } })));
});
