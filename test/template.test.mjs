import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../template.html", import.meta.url), "utf8");

test("every element the page script looks up by id exists in the markup (a removed card would throw in the browser)", () => {
  const script = html.slice(html.indexOf("<script>\nconst DATA"));
  const wanted = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]);
  assert.ok(wanted.length > 10);
  const createdByTheScript = new Set(["print-dynamic-styles"]); // looked up to be updated or removed; the page adds it while printing
  const missing = [...new Set(wanted)].filter(id => !createdByTheScript.has(id) && !html.includes(`id="${id}"`));
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

test("the figures live in ONE block: three rows (cost, cache, sessions) of three label / value cells, rows divided by a line", () => {
  assert.doesNotMatch(html, /kpis-stats/, "the separate card strips are gone");
  const block = html.match(/<div class="kpi-block">([\s\S]*?)\n  <\/div>\n\n  <div class="grid">/);
  assert.ok(block, "one .kpi-block followed by the charts");
  const rows = [...block[1].matchAll(/<div class="kpi-row"(?: id="([\w-]+)")?( hidden)?>/g)].map(m => [m[1], Boolean(m[2])]);
  assert.deepEqual(rows, [["cost-strip", false], ["cache-strip", false], ["session-strip", true]], "min/avg/max, cache, sessions (the last only on its tab)");
  assert.equal([...block[1].matchAll(/<div class="kpi"/g)].length, 9, "three cells per row");
  assert.equal([...block[1].matchAll(/<div class="label"/g)].length, 9, "each cell has a label…");
  assert.equal([...block[1].matchAll(/<div class="value"/g)].length, 9, "…and a value");
  assert.match(html, /\.kpi-row \+ \.kpi-row \{ border-top: 1px solid var\(--border\); \}/, "the horizontal divider between rows");
  assert.match(html, /\.kpi-block \{[^}]*background: var\(--panel\)[^}]*border: 1px solid var\(--border\)/, "the block, not each cell, is the card");
  assert.doesNotMatch(html.match(/\.kpi \{[^}]*\}/)[0], /border|background/, "a cell has no card styling of its own");
});

test("the figures block has the same insets as the table card, so its dividers do not run to the edges", () => {
  const card = html.match(/\.card \{[^}]*padding: (\d+)px/)[1];
  const cell = html.match(/th, td \{[^}]*padding: \d+px (\d+)px/)[1];
  assert.match(html, new RegExp(`\\.kpi-block \\{[^}]*padding: 0 ${card}px`), "horizontal padding = the card's padding, so the lines start inside the block");
  assert.match(html, new RegExp(`\\.kpi \\{ padding: \\d+px ${cell}px;`), "a cell's side padding = a table cell's, so labels line up with the table text");
  assert.doesNotMatch(html.match(/\.kpi-row \{[^}]*\}/)[0], /margin|padding/, "the rows themselves sit inside the padded block (their lines get the inset)");
});

test("print stylesheet: the active tab prints on a white page — controls hidden, header on every table page, rows whole, charts fitted", () => {
  const block = html.match(/@media print \{[\s\S]*?\n  \}\n/)[0];
  assert.match(block, /@page \{[^}]*size: A4 landscape;[^}]*margin: 1\.5cm 1\.4cm 1\.7cm;/, "A4 landscape: the tables have up to ten columns (portrait squeezed Models and broke dates), and margins");
  assert.match(block, /@bottom-right \{ content: counter\(page\) " \/ " counter\(pages\)/, "page x / y");
  assert.match(block, /:root \{ --bg: #fff; --panel: #fff;[^}]*--text: #000;/, "light variables whatever the theme");
  assert.match(block, /\.tabs-row, \.header-actions, \.tab-sep, \.footer \.links \{ display: none !important; \}/, "tabs, year / period controls, buttons and links are not printed");
  assert.match(block, /button, select \{ display: none !important; \}/);
  assert.match(block, /thead \{ display: table-header-group; \}/, "the header repeats on every page");
  assert.match(block, /thead, thead th \{ position: static !important; \}/);
  assert.match(block, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/, "a row is never cut in two");
  assert.match(block, /\.kpi-block, \.grid, \.grid \.card \{ break-inside: avoid;/, "figures and charts stay whole");
  assert.match(block, /\.table-card \{ break-inside: auto;/, "the table itself may run over pages");
  assert.match(block, /\.grid \{ grid-template-columns: 2fr 1fr !important;/, "the chart row keeps two columns on the narrow page (the 800px rule would stack it)");
  assert.match(block, /canvas \{ max-width: 100% !important; max-height: 250px;/);
  assert.match(block, /a::after \{ content: none !important; \}/, "no URL after a link");
  assert.match(block, /tbody tr\.total td \{[^}]*print-color-adjust: exact; background: #eee;/, "the Total row keeps its shading on paper");
});

test("print stylesheet: it comes last so it wins over both themes, and the print-only context line is hidden on screen", () => {
  assert.ok(html.indexOf("@media print") > html.indexOf('[data-theme="light"] {'), "after the light theme block");
  assert.ok(html.indexOf("@media print") > html.indexOf("@media (max-width: 800px)"), "after the narrow-screen rule");
  assert.match(html, /\.print-context \{ display: none; \}/);
  assert.match(html, /\.print-context \{ display: block;/, "shown only inside @media print");
  assert.ok(html.indexOf(".print-context { display: none; }") < html.indexOf("@media print"));
  assert.match(html, /<div class="card table-card">\s*<table id="tbl">/);
  assert.match(html, /<span class="links"><a href="https:\/\/github\.com\/okrasn\/ai-usage-cost"/, "the links are marked so the print sheet can drop them");
  assert.doesNotMatch(html, /Claude Usage Dashboard/, "the footer follows the rename");
});

test("the address in the printed footer is the npm page the on-screen footer links to", () => {
  const printed = html.match(/const PACKAGE_PAGE = "([^"]+)";/)[1];
  const links = [...html.matchAll(/<a href="https:\/\/(?:www\.)?([^"]+)" target="_blank" rel="noopener">npm<\/a>/g)].map(m => m[1]);
  assert.deepEqual(links, [printed], "one npm link in the page footer, and it points where the printout says");
});
