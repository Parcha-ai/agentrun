---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: feature
---
A call's `tool_end` reaches the host only once its outcome is in the session's records, with the text recorded as `result`, and `createHarnessRunner(...).stop({ drainMs })` pauses every node a runner is running: no new turn, tool call or paid request starts, and the calls in flight run on until their outcomes are recorded, for at most `drainMs`, before the node fails `aborted`. Run again with the same step, the node resumes from its records, and a call that finished during the pause is never run or paid for again.
- Before, the Claude Agent adapter sent `tool_end` as the tool returned, before its outcome was written, and an interrupt cut off a call in flight, so a `safe` call ran again when its session resumed.
- `AdapterSession.interrupt` takes `{ drainMs }`. An adapter that cannot drain stops at once, as before. The Claude Agent adapter drains, and refuses a new turn while it does.
- A failed call's `tool_end` carries its recorded text too.
