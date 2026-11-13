---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: breaking
---
Model defaults move to the current models. The OpenAI default (and OpenRouter's, for pi, codex and opencode) is now gpt-6.1-sol, where OpenRouter's was gpt-6-sol. The Claude Agent adapter's default is now claude-sonnet-5-5 (was claude-sonnet-4-5) and the Codex adapter's is openai/gpt-6-luna (was openai/gpt-5.4-mini). A host that relied on a default names its model; the READMEs' examples name the current ones.
