import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// runs the real bin/install.mjs against a throw-away Claude config dir and reports which <prefix>-usage skills appeared
const BIN = new URL("../bin/install.mjs", import.meta.url).pathname;
function run(args, env = {}, setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "ccud-prefix-"));
  setup(dir);
  const r = spawnSync(process.execPath, [BIN, "--skill", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: dir, ...env } });
  const skills = existsSync(join(dir, "skills")) ? readdirSync(join(dir, "skills")).sort() : [];
  return { ...r, skills, dir };
}

test("the skill prefix comes from AI_USAGE_PREFIX", () => {
  const r = run([], { AI_USAGE_PREFIX: "zz" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.skills, ["zz-usage"]);
});

test("the old CC_USAGE_PREFIX still works; AI_USAGE_PREFIX wins when both are set; --prefix wins over both", () => {
  assert.deepEqual(run([], { CC_USAGE_PREFIX: "old" }).skills, ["old-usage"]);
  assert.deepEqual(run([], { CC_USAGE_PREFIX: "old", AI_USAGE_PREFIX: "new" }).skills, ["new-usage"]);
  assert.deepEqual(run(["--prefix", "flag"], { CC_USAGE_PREFIX: "old", AI_USAGE_PREFIX: "new" }).skills, ["flag-usage"]);
});

test("with no prefix anywhere a non-interactive run falls back to 'ai' (the command is /ai-usage)", () => {
  assert.deepEqual(run([]).skills, ["ai-usage"]);
});

test("an already installed prefix beats the default: an upgrade keeps the command the user types", () => {
  const r = run([], {}, dir => {
    mkdirSync(join(dir, "skills", "ok-usage"), { recursive: true });
    writeFileSync(join(dir, "skills", "ok-usage", ".version"), "1.2.0\n");
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.skills, ["ok-usage"], "it reinstalled ok-usage; no ai-usage appeared next to it");
});

test("an invalid prefix from the environment is rejected with a message", () => {
  const r = run([], { AI_USAGE_PREFIX: "bad prefix!" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ai-usage-cost: Invalid prefix: 'bad prefix!'/);
  assert.deepEqual(r.skills, []);
});

test("a foreign skill with that name is not overwritten, and the hint names the new variable", () => {
  const r = run([], { AI_USAGE_PREFIX: "zz" }, dir => {
    mkdirSync(join(dir, "skills", "zz-usage"), { recursive: true });
    writeFileSync(join(dir, "skills", "zz-usage", "SKILL.md"), "someone else's skill\n");
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /AI_USAGE_PREFIX=<prefix>/);
  assert.doesNotMatch(r.stderr + r.stdout, /CC_USAGE_PREFIX/);
});

test("--help documents AI_USAGE_PREFIX and the old name", () => {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.match(r.stdout, /set AI_USAGE_PREFIX; the old name CC_USAGE_PREFIX still works/);
});
