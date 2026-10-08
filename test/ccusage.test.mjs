import assert from "node:assert/strict";
import { test } from "node:test";
import { failureReason, fetchDaily, parseJson } from "../lib/ccusage.mjs";
import { fail, ok } from "./helpers.mjs";

const doc = JSON.stringify({ daily: [], totals: {} });

test("prefers the Claude-only report", () => {
  const calls = [];
  const out = fetchDaily({ run: (cmd, args) => (calls.push(args.join(" ")), ok(doc)) });
  assert.deepEqual(out.daily, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /ccusage claude daily --json --breakdown/);
});

test("falls back to plain `daily` for ccusage versions without the `claude` subcommand", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args.join(" "));
    return args.includes("claude") ? fail("Command not found: claude") : ok(doc);
  };
  assert.deepEqual(fetchDaily({ run }).daily, []);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /ccusage daily --json --breakdown/);
});

test("reports every failed attempt when ccusage is unusable", () => {
  const run = () => fail("npm error 401 Unauthorized");
  assert.throws(() => fetchDaily({ run }), err =>
    /ccusage claude daily: exit 1/.test(err.message) &&
    /ccusage daily: exit 1/.test(err.message) &&
    /401 Unauthorized/.test(err.message)
  );
});

test("a missing npx is reported, not thrown as a raw ENOENT", () => {
  const run = () => ({ error: new Error("spawn npx ENOENT") });
  assert.throws(() => fetchDaily({ run }), /spawn npx ENOENT/);
});

test("parseJson tolerates banners around the document and rejects non-JSON", () => {
  assert.deepEqual(parseJson(`warning: cache stale\n{"a":1}\n`), { a: 1 });
  assert.throws(() => parseJson("nothing here"), /did not print JSON/);
});

test("failure reason is the error line, not the tail of the stack trace", () => {
  const stderr = [
    "file:///x/data-loader.js:5351",
    "\t\tthrow new Error(`No valid Claude data directories found`);",
    "Error: No valid Claude data directories found in CLAUDE_CONFIG_DIR.",
    "    at getClaudePaths (file:///x/data-loader.js:5351:9)",
    "Node.js v22.14.0",
  ].join("\n");
  assert.match(failureReason(stderr), /^Error: No valid Claude data directories/);
  assert.equal(failureReason("plain failure"), "plain failure");
  assert.equal(failureReason(""), "");
});
