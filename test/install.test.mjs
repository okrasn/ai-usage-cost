import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCommandLine, compareVersions, installDashboard, installSkill, installedPrefixes } from "../lib/install.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ccud-"));
const quiet = () => {};

function fakePackage() {
  const root = tmp();
  for (const d of ["lib", "skill"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "build.mjs"), "// build");
  writeFileSync(join(root, "template.html"), "<html/>");
  writeFileSync(join(root, "lib", "x.mjs"), "export {}");
  writeFileSync(join(root, "lib", "install.mjs"), "export {}");
  writeFileSync(join(root, "skill", "SKILL.md"), "---\nname: __SKILL_NAME__\ndisable-model-invocation: true\n---\n\n!`__BUILD_CMD__`\n");
  return root;
}

test("compareVersions follows semver precedence", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.2.0", "1.2.0-beta.1"), 1); // release beats its prerelease
  assert.equal(compareVersions("1.2.0-beta.1", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("1.1.1", "0.0.0"), 1);
});

test("installDashboard: fresh install, skip when current, upgrade, force", () => {
  const src = fakePackage();
  const dst = join(tmp(), "dashboard");
  installDashboard({ srcRoot: src, dstDir: dst, pkgVersion: "1.2.0", log: quiet });
  for (const f of ["build.mjs", "template.html", "lib/x.mjs", ".version"]) assert.ok(existsSync(join(dst, f)), f);
  assert.ok(!existsSync(join(dst, "lib", "install.mjs")), "installer is not part of the installed dashboard");

  writeFileSync(join(dst, "config.json"), '{"weekStart":"monday"}'); // user file
  writeFileSync(join(dst, "build.sh"), "legacy");
  const msgs = [];
  installDashboard({ srcRoot: src, dstDir: dst, pkgVersion: "1.2.0", log: m => msgs.push(m) });
  assert.match(msgs[0], /skipping/);
  assert.equal(readFileSync(join(dst, "build.sh"), "utf8"), "legacy", "no-op run must not touch files");

  installDashboard({ srcRoot: src, dstDir: dst, pkgVersion: "1.3.0", log: quiet });
  assert.equal(readFileSync(join(dst, ".version"), "utf8").trim(), "1.3.0");
  const shim = readFileSync(join(dst, "build.sh"), "utf8");
  assert.match(shim, /^#!\/usr\/bin\/env bash/);
  assert.ok(shim.includes(`exec node "${join(dst, "build.mjs")}" "$@"`), "legacy build.sh becomes a shim over build.mjs");
  assert.equal(readFileSync(join(dst, "config.json"), "utf8"), '{"weekStart":"monday"}');

  installDashboard({ srcRoot: src, dstDir: dst, pkgVersion: "1.3.0", force: true, log: msgs.push.bind(msgs) });
  assert.match(msgs.at(-1), /upgraded/);
});

test("a fresh install does not create a build.sh shim", () => {
  const dst = join(tmp(), "dashboard");
  installDashboard({ srcRoot: fakePackage(), dstDir: dst, pkgVersion: "1.2.0", log: quiet });
  assert.ok(!existsSync(join(dst, "build.sh")));
});

const skillArgs = (over = {}) => ({
  srcRoot: fakePackage(), skillsDir: tmp(), commandsDir: tmp(), dashboardDir: "/d", useTilde: false, prefix: "my", pkgVersion: "1.3.0", log: quiet, ...over,
});

test("installSkill refuses to overwrite a skill it did not install (e.g. a hand-written one)", () => {
  const args = skillArgs();
  const file = join(args.skillsDir, "my-usage", "SKILL.md");
  mkdirSync(join(args.skillsDir, "my-usage"));
  writeFileSync(file, "someone else's skill");
  assert.throws(() => installSkill(args), /not installed by this package/);
  assert.equal(readFileSync(file, "utf8"), "someone else's skill");
  installSkill({ ...args, force: true });
  assert.match(readFileSync(file, "utf8"), /!`node "\/d\/build\.mjs"`/);
});

test("installSkill writes a manual-only skill with the documented !`cmd` injection form", () => {
  const args = skillArgs({ prefix: "ok", useTilde: true });
  installSkill(args);
  const body = readFileSync(join(args.skillsDir, "ok-usage", "SKILL.md"), "utf8");
  assert.match(body, /^name: ok-usage$/m);
  assert.match(body, /^disable-model-invocation: true$/m);
  assert.match(body, /^!`node ~\/\.claude\/dashboard\/build\.mjs`$/m);
  assert.ok(!/__[A-Z_]+__/.test(body), "no unreplaced placeholders");
  assert.deepEqual(installedPrefixes({ skillsDir: args.skillsDir }), ["ok"]);
});

test("installSkill: skip when current, upgrade when newer", () => {
  const args = skillArgs();
  installSkill({ ...args, pkgVersion: "1.3.0" });
  const msgs = [];
  installSkill({ ...args, pkgVersion: "1.3.0", log: m => msgs.push(m) });
  assert.match(msgs[0], /skipping/);
  installSkill({ ...args, pkgVersion: "1.4.0", log: m => msgs.push(m) });
  assert.match(msgs.at(-1), /upgraded/);
});

test("installSkill retires a legacy command that this package installed, but only reports a foreign one", () => {
  const ours = skillArgs();
  writeFileSync(join(ours.commandsDir, "my-usage.md"), "!bash old");
  writeFileSync(join(ours.commandsDir, ".my-usage.version"), "1.2.0\n");
  const msgs = [];
  installSkill({ ...ours, log: m => msgs.push(m) });
  assert.ok(!existsSync(join(ours.commandsDir, "my-usage.md")) && !existsSync(join(ours.commandsDir, ".my-usage.version")));
  assert.ok(msgs.some(m => /Removed the legacy slash command/.test(m)));

  const foreign = skillArgs();
  writeFileSync(join(foreign.commandsDir, "my-usage.md"), "mine");
  const fmsgs = [];
  installSkill({ ...foreign, log: m => fmsgs.push(m) });
  assert.equal(readFileSync(join(foreign.commandsDir, "my-usage.md"), "utf8"), "mine", "foreign command is left alone");
  assert.ok(fmsgs.some(m => /name collision/.test(m)));
});

test("installedPrefixes sees skills and legacy commands we installed, and ignores unmarked ones", () => {
  const skillsDir = tmp();
  const commandsDir = tmp();
  mkdirSync(join(skillsDir, "aa-usage"));
  writeFileSync(join(skillsDir, "aa-usage", ".version"), "1.3.0\n");
  mkdirSync(join(skillsDir, "bb-usage")); // user's own skill, no marker
  writeFileSync(join(commandsDir, "cc-usage.md"), "x");
  writeFileSync(join(commandsDir, ".cc-usage.version"), "1.2.0\n");
  writeFileSync(join(commandsDir, "dd-usage.md"), "x"); // foreign command
  assert.deepEqual(installedPrefixes({ skillsDir, commandsDir }), ["aa", "cc"]);
  assert.deepEqual(installedPrefixes({ skillsDir: join(skillsDir, "nope"), commandsDir: join(commandsDir, "nope") }), []);
});

test("buildCommandLine: tilde only for the default POSIX location", () => {
  assert.equal(buildCommandLine("/x/dashboard", { useTilde: true }), "node ~/.claude/dashboard/build.mjs");
  assert.equal(buildCommandLine("/x/dashboard"), 'node "/x/dashboard/build.mjs"');
});
