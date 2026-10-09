import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS, DEFAULT_AGENT, agentIds, agentMeta, selectAgents } from "../lib/agents/index.mjs";
import { claudeAgent } from "../lib/agents/claude.mjs";

const CAPS = ["cache", "time", "projects", "sessions", "subagents", "thinking"];
const fake = id => ({ id, label: id.toUpperCase(), capabilities: Object.fromEntries(CAPS.map(c => [c, false])), detect: () => true, read: () => ({}) });

test("every registered agent honours the contract the framework relies on", () => {
  assert.ok(AGENTS.length >= 1);
  assert.equal(AGENTS[0].id, DEFAULT_AGENT, "Claude Code is first: it is the main agent unless config says otherwise");
  assert.equal(new Set(agentIds()).size, AGENTS.length, "ids are unique");
  for (const a of AGENTS) {
    assert.match(a.id, /^[a-z][a-z0-9-]*$/, `${a.id}: a stable lower-case key (it is written into history.json)`);
    assert.ok(typeof a.label === "string" && a.label.length > 0, `${a.id}: label`);
    assert.deepEqual(Object.keys(a.capabilities).sort(), [...CAPS].sort(), `${a.id}: declares every capability`);
    assert.ok(Object.values(a.capabilities).every(v => typeof v === "boolean"), `${a.id}: capabilities are booleans`);
    assert.equal(typeof a.detect, "function");
    assert.equal(typeof a.read, "function");
  }
});

test("selectAgents: 'auto' or nothing = all, a list = those in that order without repeats, unknown ids are named with the known ones", () => {
  const registry = [fake("claude"), fake("gemini"), fake("codex")];
  assert.deepEqual(selectAgents("auto", registry).map(a => a.id), ["claude", "gemini", "codex"]);
  assert.deepEqual(selectAgents(undefined, registry).map(a => a.id), ["claude", "gemini", "codex"]);
  assert.deepEqual(selectAgents(["codex", "claude", "codex"], registry).map(a => a.id), ["codex", "claude"]);
  assert.throws(() => selectAgents(["claude", "gpt"], registry), /unknown agent "gpt" \(known: claude, gemini, codex\)/);
  assert.throws(() => selectAgents(["a", "b"], registry), /unknown agent "a", "b"/);
  const all = selectAgents("auto", registry);
  all.pop();
  assert.equal(registry.length, 3, "the result is a copy: the registry is not altered");
});

test("agentMeta gives the page a label and a COPY of the capabilities", () => {
  const meta = agentMeta(claudeAgent);
  assert.deepEqual(meta, { id: "claude", label: "Claude Code", capabilities: claudeAgent.capabilities });
  meta.capabilities.time = false;
  assert.equal(claudeAgent.capabilities.time, true);
});

test("the Claude Code agent: detect() finds the log folder, read() returns what readLogs does", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccud-agent-"));
  assert.equal(claudeAgent.detect({ env: { CLAUDE_CONFIG_DIR: dir }, home: dir }), false, "no projects folder yet");
  mkdirSync(join(dir, "projects", "p"), { recursive: true });
  writeFileSync(join(dir, "projects", "p", "s.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-10-08T10:00:00Z", requestId: "r", sessionId: "S", message: { id: "m", model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 7 } } }) + "\n");
  assert.equal(claudeAgent.detect({ env: { CLAUDE_CONFIG_DIR: dir }, home: dir }), true);
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const r = claudeAgent.read({ projects: true, time: false, sessions: true, titles: true });
    assert.equal(r.buckets.length, 1);
    assert.equal(r.buckets[0].output, 7);
    assert.equal(r.sessions[0].id, "S");
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
  }
});
