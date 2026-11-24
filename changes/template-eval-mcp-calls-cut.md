---
packages: @parcha/agentrun-serve
kind: fix
---
A template eval no longer shows a fake MCP server's call arguments raw. The llm grader's `<mcp-calls>` block and the report's `mcp_calls` were built from each fake's own log, the arguments whole, so a value the run's cut holds (a server key, a handed key, a key-shaped string) that the agent passed to a fake tool reached the grader's provider and the report as typed. The timeline's copy of the same call was cut. Both now come from the run's timeline under its cut: the faked servers' calls that the fakes' own logs show reached them (a call the run refused before it ran, or one that never left, is left out), so the grader sees what reached the fake, cut. A refused call is still in the report's `calls`, now marked `refused: true`. The fake's own log is read only to match a `tool_used` grader's `args` on a faked tool, and is never shown.
