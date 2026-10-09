import { claudeAgent } from "./claude.mjs";

// The agents this version can read, in the order the drop-down lists them. Adding a tool = adding a file next to claude.mjs
// and listing it here (see TODO.md, "Other agents").
export const AGENTS = [claudeAgent];
export const DEFAULT_AGENT = "claude";

export const agentIds = (registry = AGENTS) => registry.map(a => a.id);

// config.json "agents": "auto" (every agent that has data) or a list of ids to show, in that order.
export function selectAgents(setting, registry = AGENTS) {
  if (setting === "auto" || setting === undefined) return [...registry];
  const byId = new Map(registry.map(a => [a.id, a]));
  const unknown = setting.filter(id => !byId.has(id));
  if (unknown.length) throw new Error(`unknown agent ${unknown.map(id => `"${id}"`).join(", ")} (known: ${agentIds(registry).join(", ")})`);
  return [...new Set(setting)].map(id => byId.get(id));
}

// what the page needs to know about an agent
export const agentMeta = a => ({ id: a.id, label: a.label, capabilities: { ...a.capabilities } });
