---
packages: @parcha/agentrun-import
kind: feature
---
`@parcha/agentrun-import` reads GitHub Copilot CLI, a new source (`copilot`): each session's `$COPILOT_HOME/session-state/<id>/events.jsonl` (`~/.copilot` without `COPILOT_HOME`), and an older CLI's `session-state/<id>.jsonl`. `normalizeUsage("copilot", …)` takes the cache read and write out of `inputTokens` and keeps `reasoningTokens` as `reasoning`.
- Copilot writes no request's tokens to disk (`assistant.usage` is ephemeral). A session's tokens are the per-model totals of the `session.shutdown` each CLI process writes as it exits; a shutdown that holds the session's whole total (a CLI that keeps its accounting across processes) counts only what it adds. A session with no shutdown, still running or killed, has tokens 0. Copilot writes no dollar cost, so `cost` is `null` unless each request's tokens are known.
- Each persisted `assistant.message` is one request, keyed by its `messageId` (a response split into chunks is one); each event counts once by its `id`, and a rotated journal's `checkpoint: true` records are copies. Subagent, autopilot, skill and agent-written user messages are not the person's turns.
- serve's import still imports runs from Claude Code, Codex and pi alone (`IMPORT_SOURCES`), the sources its `imported_from` names; Copilot sessions count in the package's `parseHome` and its CLI.
