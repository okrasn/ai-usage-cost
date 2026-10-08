import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCommandLine, compareVersions, installCommand, installDashboard, installedPrefixes } from "../lib/install.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ccud-"));
const quiet = () => {};

function fakePackage() {
  const root = tmp();
  for (const d of ["lib", "commands"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "build.mjs"), "// build");
  writeFileSync(join(root, "template.html"), "<html/>");
  writeFileSync(join(root, "lib", "x.mjs"), "export {}");
  writeFileSync(join(root, "lib", "install.mjs"), "export {}");
  writeFileSync(join(root, "commands", "ok-usage.md"), "---\n---\n\n!__BUILD_CMD__\n");
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

test("installCommand refuses to overwrite a command it did not install", () => {
  const src = fakePackage();
  const commandsDir = tmp();
  writeFileSync(join(commandsDir, "my-usage.md"), "someone else's command");
  const args = { srcRoot: src, commandsDir, dashboardDir: "/d", prefix: "my", pkgVersion: "1.2.0", log: quiet };
  assert.throws(() => installCommand(args), /not installed by this package/);
  assert.equal(readFileSync(join(commandsDir, "my-usage.md"), "utf8"), "someone else's command");
  installCommand({ ...args, force: true });
  assert.match(readFileSync(join(commandsDir, "my-usage.md"), "utf8"), /node "\/d\/build\.mjs"/);
});

test("installCommand: install → recognised as ours → skip/upgrade", () => {
  const src = fakePackage();
  const commandsDir = tmp();
  const args = { srcRoot: src, commandsDir, dashboardDir: "/d", useTilde: true, prefix: "ok", pkgVersion: "1.2.0" };
  installCommand({ ...args, log: quiet });
  assert.match(readFileSync(join(commandsDir, "ok-usage.md"), "utf8"), /^!node ~\/\.claude\/dashboard\/build\.mjs$/m);
  assert.deepEqual(installedPrefixes(commandsDir), ["ok"]);

  const msgs = [];
  installCommand({ ...args, log: m => msgs.push(m) });
  assert.match(msgs[0], /skipping/);
  installCommand({ ...args, pkgVersion: "1.3.0", log: m => msgs.push(m) });
  assert.match(msgs.at(-1), /upgraded/);
});

test("installedPrefixes ignores usage files without our version marker", () => {
  const dir = tmp();
  writeFileSync(join(dir, "foo-usage.md"), "x");
  writeFileSync(join(dir, "bar-usage.md"), "x");
  writeFileSync(join(dir, ".bar-usage.version"), "1.0.0\n");
  assert.deepEqual(installedPrefixes(dir), ["bar"]);
  assert.deepEqual(installedPrefixes(join(dir, "missing")), []);
});

test("buildCommandLine: tilde only for the default POSIX location", () => {
  assert.equal(buildCommandLine("/x/dashboard", { useTilde: true }), "node ~/.claude/dashboard/build.mjs");
  assert.equal(buildCommandLine("/x/dashboard"), 'node "/x/dashboard/build.mjs"');
});
