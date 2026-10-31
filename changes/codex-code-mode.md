---
packages: @parcha/agentrun-codex
kind: fix
---
A model that runs its tools in code mode, such as gpt-6-sol, now runs on the Codex adapter; it was refused before any request. The adapter no longer reads the binary's model catalog or refuses a code-mode model when a session is checked, and the proxy passes Codex's `exec` and `wait` (and drops the sub-agent and user-input tools listed beside them, and refuses a code-mode request that allows parallel tool calls). A host tool the script calls arrives as a nested call under an id of Codex's own, which no line of the session's log carries, so a `never` tool called that way was declined for good; it now runs once, as soon as the `exec` it runs under is in the log.
