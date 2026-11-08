---
packages: @parcha/agentrun-serve
kind: ci
---
A claude-agent run whose process is SIGKILLed while its Claude CLI has a model request out leaves nothing running: a test now holds that every process under the killed one, the CLI among them, is gone within 2 s of the kill, that the CLI's model proxy refuses connections, that no request reaches the provider from the killed process, and that the run completes on its next process.
