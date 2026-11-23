---
packages: @parcha/agentrun-serve
kind: feature
---
The session importer can read OpenCode's history: `readOpenCode(home)` reads every session in `~/.local/share/opencode/opencode*.db` (1.x and 2.x schemas) and in the JSON storage OpenCode kept before SQLite, with each request's tokens (input without the cache, output with the reasoning, cache reads and writes), its cost, its tool calls and results, and a subagent's session under its parent. It reads with `node:sqlite` on Node and `bun:sqlite` under Bun.
