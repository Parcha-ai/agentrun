---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: breaking
---
A provider-native web search's fee is one constant, `NATIVE_SEARCH_USD` ($0.01, $10 per 1,000), instead of three copies. The price does not change.
- Kernel: `@parcha/agentrun-kernel/host` exports `NATIVE_SEARCH_USD`. The Claude and Codex proxy policies and the runner's hosted search all read it.
- `@parcha/agentrun-harness-claude` no longer exports `CLAUDE_WEB_SEARCH_USD`; read `NATIVE_SEARCH_USD` from `@parcha/agentrun-kernel/host`.
