---
packages: @parcha/agentrun-serve
kind: fix
---
On pi, a tool call that is already running beside a call waiting for approval now finishes and keeps its result. Before, when one answer from the model made two MCP calls, a read that runs on its own and a write that asks, the run paused on the write at once and cut the read before it reached its server. Once the write was answered, the model was told the read was interrupted and may have partly run, so it ran the read again.
- The pause now waits up to 30 seconds for the calls already running beside it to end, so their results are kept and the model gets them with the answer to the waiting call. Nothing runs twice.
- A call that is still running after 30 seconds is cut, as before, and the model is told it was interrupted.
- No new call starts while the pause waits. One the model made in the same answer is asked about again when the run goes on, and runs then.
- A cancel or stop while the pause waits ends the run at once.
- Claude Code, Codex and OpenCode are unchanged: their pause lets the run go at once, and their resume keeps a finished call's result.
