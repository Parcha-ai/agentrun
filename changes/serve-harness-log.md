---
packages: @parcha/agentrun-serve
kind: fix
---
A codex or claude-agent run's model proxy now reports to the run's log. serve gave neither adapter a log, so the proxy's lines were dropped: a refused request, a response whose ids could not be written, a usage or a price that could not be read. Each is now one JSON line in the run's `process.log` (`event: "harness"`, with the harness's id). A request's path is written without its query string, and every value of the environment's key-shaped variables (`*_API_KEY`, `*_TOKEN`, `*SECRET*`) is cut out of the line, so a key a caller sent, or one serve holds, never reaches the log. A failed run's message is never taken from such a line: it comes from the process's own last line before them.
