---
packages: @parcha/agentrun-import, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-import` reads Cursor's CLI (`cursor-agent`) as a source (`cursor`, run by serve's `cursor` harness). Each chat is a SQLite store of its own, `<config>/chats/<workspace hash>/<agent id>/store.db` (an ACP session's in `<config>/acp-sessions/<id>/`), where `<config>` is `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`, as cursor-agent picks it. SQLite goes through `node:sqlite` on Node and `bun:sqlite` under Bun.
- Cursor keeps no tokens, cost or error for a request on the machine; its usage is on Cursor's server. Each assistant message counts as one request of unknown tokens (serve's `unmetered`), never 0, and a chat's cost is `null`. The model is the agent's `lastUsedModel`, as `cursor/<model>`, when the store names one.
- A chat is read once, whole, in its root's message order. There is no cursor (`null`) and no resumed read: each read reads the store again. A message the root names that the store does not hold is passed over.
- No message has a time of its own. Every turn is at the chat's start (its root's, else the agent's `createdAt`), and the chat ends at `meta.json`'s `updatedAtMs`. Time at work is that span when it is under the 15-minute gap, else 0.
- A chat's id is its folder's name, the agent id: `cursorSessionId(file)`, which serve uses too. A subagent's chat (`subagentInfo`) is a child of the agent it names. Cursor's default name, `New Agent`, is no title.
- `turns: false` keeps no prompt, answer text, tool output or call argument in its requests.
- The store is opened read-only with a 5 s busy timeout and only SELECTed from. The store's SQL guard (`scripts/store-sql-guard.test.mjs`) allows SQL outside the store in that one named file and holds it to SELECTs, its busy timeout and read-only opens. The guard also finds a driver module named through a const (`const NODE_SQLITE = "node:sqlite"; await import(NODE_SQLITE)`) and counts `bun:sqlite` as a driver.
- serve imports Cursor runs under a `cursor` revision whose instructions are the project's AGENTS.md, else its CLAUDE.md. The project's `.cursor/skills` folder is among its skill folders. serve reads `~/.cursor` under the home it imports.
- serve: the `imported_from.source` and `by_source` enums and `ImportSource` include `cursor`, and `agentrun-serve import --from` takes it. A chat left out of a chosen project's import (still being written) is told by the workspace its `meta.json` names.
