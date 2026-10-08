import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSaneTable, fromLiteLLM } from "../lib/price-table.mjs";

const entry = (inM, outM, cwM, crM, extra = {}) => ({
  litellm_provider: "anthropic",
  input_cost_per_token: inM / 1e6, output_cost_per_token: outM / 1e6,
  cache_creation_input_token_cost: cwM / 1e6, cache_read_input_token_cost: crM / 1e6, ...extra,
});

test("fromLiteLLM keeps Anthropic claude-* entries with all four rates, in USD per million tokens", () => {
  const models = fromLiteLLM({
    "claude-sonnet-5": entry(2, 10, 2.5, 0.2, { cache_creation_input_token_cost_above_1hr: 4 / 1e6 }),
    "claude-old": entry(3, 15, 3.75, 0.3, { input_cost_per_token_above_200k_tokens: 6 / 1e6 }),
    "bedrock/claude-x": entry(1, 1, 1, 1),
    "claude-vertex": { ...entry(1, 1, 1, 1), litellm_provider: "vertex_ai" },
    "claude-no-cache": { litellm_provider: "anthropic", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    "gpt-5": entry(1, 1, 1, 1),
  });
  assert.deepEqual(Object.keys(models), ["claude-old", "claude-sonnet-5"]);
  assert.deepEqual(models["claude-sonnet-5"], { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2, cacheWrite1h: 4 });
  assert.equal(models["claude-old"].tiered, true);
  assert.deepEqual(fromLiteLLM(null), {});
});

test("assertSaneTable rejects tiny, negative and absurd tables", () => {
  const ok = Object.fromEntries(["a", "b", "c", "d", "e"].map(n => [n, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }]));
  assert.doesNotThrow(() => assertSaneTable(ok));
  assert.throws(() => assertSaneTable({ a: ok.a }), /only 1 Claude models/);
  assert.throws(() => assertSaneTable({ ...ok, a: { ...ok.a, output: -1 } }), /implausible output rate for a/);
  assert.throws(() => assertSaneTable({ ...ok, a: { ...ok.a, input: 5000 } }), /implausible input rate for a/);
  assert.throws(() => assertSaneTable({ ...ok, a: { ...ok.a, cacheRead: NaN } }), /implausible cacheRead/);
});
