#!/usr/bin/env node
// Dev-time tool (not shipped in the npm package): refreshes vendor/prices.json from LiteLLM's public price table.
// Usage: node scripts/update-prices.mjs [--check]   (--check: print a diff summary, do not write)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LITELLM_URL, assertSaneTable, fromLiteLLM } from "../lib/price-table.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "prices.json");

const res = await fetch(LITELLM_URL);
if (!res.ok) throw new Error(`${LITELLM_URL}: HTTP ${res.status}`);
const sorted = fromLiteLLM(await res.json());
assertSaneTable(sorted);
const snap = { source: LITELLM_URL, fetchedAt: new Date().toISOString().slice(0, 10), unit: "USD per million tokens", models: sorted };

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).models : {};
const added = Object.keys(sorted).filter(k => !prev[k]);
const changed = Object.keys(sorted).filter(k => prev[k] && JSON.stringify(prev[k]) !== JSON.stringify(sorted[k]));
console.log(`${Object.keys(sorted).length} models (+${added.length} new, ${changed.length} changed${added.length ? `: ${added.join(", ")}` : ""})`);
if (changed.length) console.log(`changed: ${changed.join(", ")}`);
if (process.argv.includes("--check")) process.exit(0);
writeFileSync(OUT, JSON.stringify(snap, null, 2) + "\n");
console.log(`wrote ${OUT}`);
