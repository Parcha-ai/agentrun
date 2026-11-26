---
packages: @parcha/agentrun-harness-claude
kind: fix
---
A claude-agent run on a local model (an Ollama model, or any model AgentRun's route translates onto Anthropic's Messages) no longer ends with no answer. On a slow machine such a model can send nothing on its stream for over five minutes while it loads, reads its prompt or thinks. Claude Code gave the stream up at five minutes, asked again without streaming, and got the answer whole. AgentRun only heard the streamed text, so the run completed at $0 with `final_answer: null` and no answer on its timeline. The text of a message that comes whole is now said once, as the turn's answer, and a message whose text did stream is never said twice. On a translated model the CLI now waits up to 30 minutes on a silent stream (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`), so the first request is no longer thrown away. On a provider's own Messages the CLI keeps its default.
