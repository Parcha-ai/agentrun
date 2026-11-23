---
packages: @parcha/agentrun-import, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-import` reads OpenCode, its fourth source (`opencode`, run by serve's `opencode` harness). It reads every session in `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`): the `opencode*.db` databases (1.x and 2.x schemas), the one `OPENCODE_DB` names, and the JSON storage OpenCode kept before SQLite. SQLite goes through `node:sqlite` on Node and `bun:sqlite` under Bun.
- One locator per session: `{ file: <db>, id }`, or a storage session's JSON file. A session is listed once, from the first database that holds it. A 2.x session wins over the 1.x copy beside it, and a 2.x fork's rows copied from its source count nothing. The known-answer key of a database session is the sha256 of `<db path relative to the home>#<session id>`.
- The cursor holds the database's device and inode and a stamp of the session's rows. An unchanged session is not read again, a changed one is read again whole, and a replaced database is read from its start.
- Each step of an OpenCode message is one request, at its `step-finish` usage. `normalizeUsage("opencode", …)` adds the reasoning to `output` and keeps it as `reasoning`. When an older OpenCode's `total` shows that its output already held the reasoning, the output stays as written.
- A request OpenCode ran on its claude-agent provider names the Claude Code session that also holds it (`mirrors`, per request and per session). When `parseHome` reads that Claude Code session in the same call, the request counts there and not again in OpenCode's totals (tokens, calls, cost). Otherwise it counts in OpenCode's.
- `parseHome` adds a subagent's own written cost to its parent's for every source except Claude Code, whose `cost-state` already holds it. OpenCode's subagents are sessions of their own.
- serve: the `imported_from.source` and `by_source` enums and `ImportSource` include `opencode`, and `agentrun-serve import --from` takes it.
