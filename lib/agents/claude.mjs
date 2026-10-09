import { homedir } from "node:os";
import { logRoots, readLogs } from "../logs.mjs";

// An agent is one AI tool whose local logs the dashboard can read. Its contract:
//   id            stable key, stored in history.json ("claude") — never rename it
//   label         what the heading shows: "<label> AI Usage Dashboard"
//   capabilities  what the tool records, so the page shows only what is true for it:
//                   cache     cache read / write tokens exist (the cache panel makes sense)
//                   time      timestamps for active time and $/hour
//                   projects  a working directory per message
//                   sessions  a session id (and, optionally, titles / branches / pull requests)
//                   subagents a message can be written by a subagent
//                   thinking  thinking / reasoning tokens are reported separately
//   detect({env, home})  → true when this tool has logs on this machine
//   read(opts)    → the shape readLogs() returns: { buckets, cells, time, sessions, sessionRows, stats }, where
//                   buckets are 15-minute UTC buckets { t, project, model, input, output, cacheCreation, cacheCreation1h,
//                   cacheRead } and `time` / `sessions` / `sessionRows` may be null when the tool cannot provide them.
//                   opts: { projects, time, idleMinutes, sessions, titles } (booleans / numbers from config.json)
// The framework tags everything an agent returns with its id; an agent never has to know about the others.
export const claudeAgent = {
  id: "claude",
  label: "Claude Code",
  capabilities: { cache: true, time: true, projects: true, sessions: true, subagents: true, thinking: true },
  detect: ({ env = process.env, home = homedir() } = {}) => logRoots({ env, home }).length > 0,
  read: opts => readLogs(opts),
};
