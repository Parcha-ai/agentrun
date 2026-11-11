---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A tool call refused before it ran now reads as refused in the run's Timeline, never as a call that ran and failed. This covers a tool set to deny on the server or the agent, and a call a person denied. The row reads "Refused: write deny.md: Permission denied: write is set to deny on this server…" instead of "Wrote deny.md failed: …". Every tool reads that way, named by what it would have acted on: a path, a command, a page, or the tool's name alone.

pi's adapter marks a refused call's result in its `details` with the new `CALL_REFUSED` key (from `@parcha/pi-durable-agent/timeline`). The model never reads that field, and the Timeline matches on it, never on the refusal's words. A call that ran and errored still reads "<label> failed: <error>".
