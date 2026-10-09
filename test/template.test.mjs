import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../template.html", import.meta.url), "utf8");

test("every element the page script looks up by id exists in the markup (a removed card would throw in the browser)", () => {
  const script = html.slice(html.indexOf("<script>\nconst DATA"));
  const wanted = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]);
  assert.ok(wanted.length > 10);
  const missing = [...new Set(wanted)].filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("the four summary cards are gone and the breakdown table leads with a Total row", () => {
  for (const id of ["kpi-cost", "kpi-tokens", "kpi-cache", "kpi-periods"]) assert.ok(!html.includes(id), `${id} should be removed`);
  assert.ok(html.includes('tr.className = "total"'));
  assert.ok(html.includes("tbody tr.total td"));
  assert.ok(html.includes('id="kpi-min"') && html.includes('id="kpi-avg"') && html.includes('id="kpi-max"'), "min / avg / max stay");
  // the Total row is inserted before the per-period rows
  assert.ok(html.indexOf('tr.className = "total"') < html.indexOf("(byProject ? rows : [...rows].reverse()).forEach"));
});

test("the hidden attribute really hides: a global [hidden] rule beats any author display (the period chips are display:flex)", () => {
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  // every element the page toggles with .hidden is covered by that rule — list them so a new one is noticed
  const toggled = [...html.matchAll(/getElementById\("([^"]+)"\)\.hidden\b|\b(yearSelect|n)\.hidden\b/g)];
  assert.ok(toggled.length >= 4);
  assert.ok(html.includes('<div class="range" id="range-group" hidden>'), "the chips start hidden (Today is the first tab)");
});
