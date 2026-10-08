import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readVersion } from "../lib/system.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ccud-sys-"));

test("readVersion: package.json wins, installed copies fall back to .version, otherwise empty", () => {
  const repo = tmp();
  writeFileSync(join(repo, "package.json"), '{"version":"1.2.3"}');
  writeFileSync(join(repo, ".version"), "9.9.9\n");
  assert.equal(readVersion(repo), "1.2.3");

  const installed = tmp();
  writeFileSync(join(installed, ".version"), "1.1.1\n");
  assert.equal(readVersion(installed), "1.1.1");

  assert.equal(readVersion(tmp()), "");
  const broken = tmp();
  writeFileSync(join(broken, "package.json"), "{nope");
  assert.equal(readVersion(broken), "");
});
