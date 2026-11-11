---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-codex, @parcha/agentrun-harness-claude
kind: fix
---
A codex, opencode or claude-agent run that reads one of its skills' files (`read_skill_file`) now shows the call and its result on the run's Timeline, as pi's tool calls are shown. On the runner, the adapter's own skill reader ran outside the run's record, so the Timeline had no row for it. The read now goes through the host's tool path (the record, the rule before a side effect, the host's hooks on its result); a new `SessionIO.hostTool` hands an adapter's own tool to the host, and the kernel's `hostedTool(io, tool)` applies it.
- Upgrading: nothing to change.
