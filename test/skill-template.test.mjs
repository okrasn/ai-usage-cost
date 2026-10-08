import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installSkill } from "../lib/install.mjs";

const SRC = new URL("..", import.meta.url).pathname;
const template = readFileSync(join(SRC, "skill", "SKILL.md"), "utf8");

test("the shipped skill template is manual-only and uses the documented !`cmd` form", () => {
  const [, front, body] = template.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.match(front, /^name: __SKILL_NAME__$/m);
  assert.match(front, /^disable-model-invocation: true$/m, "the model must never invoke it on its own");
  assert.match(front, /^allowed-tools: Bash\(node:\*\)$/m);
  assert.match(front, /^description: .{20,}/m, "a description keeps the skill readable in the / menu");
  assert.equal(body.trim(), "!`__BUILD_CMD__`");
});

test("installing the shipped template yields a valid skill with no placeholders left", () => {
  const skillsDir = mkdtempSync(join(tmpdir(), "ccud-skill-"));
  installSkill({ srcRoot: SRC, skillsDir, commandsDir: null, dashboardDir: "/d/dash", useTilde: false, prefix: "zz", pkgVersion: "9.9.9", log() {} });
  const out = readFileSync(join(skillsDir, "zz-usage", "SKILL.md"), "utf8");
  assert.ok(!/__[A-Z_]+__/.test(out));
  assert.match(out, /^name: zz-usage$/m);
  assert.match(out, /^!`node "\/d\/dash\/build\.mjs"`$/m);
});
