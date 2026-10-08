export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const perM = x => (typeof x === "number" ? Math.round(x * 1e6 * 1e6) / 1e6 : undefined);

// LiteLLM's public table → { model: { input, output, cacheWrite, cacheRead, [cacheWrite1h], [tiered] } }, USD per million tokens.
export function fromLiteLLM(all) {
  const models = {};
  for (const [name, v] of Object.entries(all ?? {})) {
    if (!name.startsWith("claude-") || v?.litellm_provider !== "anthropic") continue;
    const row = {
      input: perM(v.input_cost_per_token),
      output: perM(v.output_cost_per_token),
      cacheWrite: perM(v.cache_creation_input_token_cost),
      cacheRead: perM(v.cache_read_input_token_cost),
    };
    if (Object.values(row).some(x => x === undefined)) continue; // need all four rates
    const h1 = perM(v.cache_creation_input_token_cost_above_1hr);
    if (h1 !== undefined) row.cacheWrite1h = h1; // stored, not applied (see pricing.mjs)
    if (Object.keys(v).some(k => k.includes("above_200k"))) row.tiered = true; // long-context surcharge exists; not modelled
    models[name] = row;
  }
  return Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
}

// Refuse obviously broken downloads (an error page, a truncated or hostile file) instead of pricing with them.
export function assertSaneTable(models) {
  const names = Object.keys(models);
  if (names.length < 5) throw new Error(`price table has only ${names.length} Claude models`);
  for (const n of names) {
    for (const k of ["input", "output", "cacheWrite", "cacheRead"]) {
      const x = models[n][k];
      if (!Number.isFinite(x) || x < 0 || x > 1000) throw new Error(`price table: implausible ${k} rate for ${n}`);
    }
  }
}
