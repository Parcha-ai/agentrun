---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: fix
---
On Claude Code, a tool call that ran beside a call waiting for approval keeps its result. Before, when one answer from the model made two MCP calls, a read that runs on its own and a write that asks, and the run paused on the write, the read's result was lost once the run went on. The model was told the read was interrupted, so it ran the read again.
- The read had finished and its result was in the run's journal, but Claude Code had not written it to its own transcript before the pause let it go. On the resume, every call left without a result in that transcript whose end the journal holds now gets that recorded result before the CLI starts again. Nothing runs twice and nothing is asked again.
- A call the pause or a crash cut off before it ended is answered as interrupted, as before. A call the pause held before it started still runs once it is approved.
- The same rule covers every CLI harness that resumes from its own transcript (Codex, OpenCode). Codex already kept the result in its own transcript.
