---
packages: @parcha/agentrun-serve
kind: fix
---
A template eval's `llm` grader sees each tool call's arguments and the first 8,000 characters of its result, not a 500-character preview: a rubric can check which URL `web_fetch` read (its query included), what a `web_search` or monid call asked for, or the fifth row of a result. Both go through the run's redaction, so a held value or a key-shaped string reads `[redacted]` in the grader's prompt and the report.
- `GET /runs/{run_id}/timeline?calls=whole` adds `tool_input` (the call's arguments, each string cut at 2,000 characters) to each `tool_use` row and `tool_result_text` (the output's head, to 8,000 characters) to each `tool_result` row. The eval reads its runs this way, and the report's `runs[].calls` carry `arguments` and the longer `result`.
- The grader's prompt stays under 120,000 characters: past that, the longest results lose their middle first, then the middle calls, and the list says what was cut. The rubric, task and answer are never cut.
- A `tool_used` grader's `args` now match any tool's calls, not only a faked MCP tool's.
