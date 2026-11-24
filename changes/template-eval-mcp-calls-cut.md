---
packages: @parcha/agentrun-serve
kind: fix
---
A template eval no longer shows a fake MCP server's call arguments raw. The llm grader's `<mcp-calls>` block and the report's `mcp_calls` were built from each fake's own log, the arguments whole, so a value the run's cut holds (a server key, a handed key, a key-shaped string) that the agent passed to a fake tool reached the grader's provider and the report as typed. The timeline's copy of the same call was cut. Both now come from the run's timeline under its cut: the calls on a faked server's tools that ran, meaning not refused before they ran and with a result. A call that failed on its way to the fake shows with its error as its result, never as a success. A fake still answers exactly as its fixture is written.
- The report's `mcp_calls` entries change shape, from the fake log's `{tool, arguments}` (whole) to the timeline's `{tool, name, preview, arguments, status, result}`, with the arguments redacted. A refused call is still in the report's `calls`, now marked `refused: true`.
- The fake's own log is read only to match a `tool_used` grader's `args` on a faked tool, and is never shown. It is the run record's new `fakeLog`.
- For TypeScript callers: `RunRecord` gains a required `fakeLog`, and `ToolCall` gains `refused`.
- A change for callers of `GET /runs/{run_id}/timeline?calls=whole`: each string of a call's `tool_input` is now cut at 120,000 characters, as `tool_result_text` is, instead of 2,000. It still goes through the run's redaction. A grader can now read a long write whole, such as an issue body, a note or a posted digest.
- learn-bench builds its steps' records the same way, and now reads each step's timeline with `calls=whole`, as the template eval does. Before, a grader saw only the preview, which could show a call's input as nothing at all.
