---
packages: @parcha/agentrun-harness-claude
kind: fix
---
A claude-agent answer whose stream stalled partway, and that the Claude CLI then got whole, is said once: when the whole answer begins with what streamed, only the rest is said, so the timeline shows one message where it showed the streamed part and then the whole answer again. A whole retry's blocks stay one message too, including when the first block says exactly what streamed. The 30-minute wait on a silent stream (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`), which 0.1.0-beta.62 gave every model AgentRun's route translates, now applies to a model on the server's own machine (an Ollama model) alone. A paid model AgentRun translates keeps the CLI's five minutes again, so a hung stream holds the run's slot and cap no longer than that.
