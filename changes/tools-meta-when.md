---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-kernel
kind: feature
---
One discovery system. A run lists every tool until its catalog tools (MCP and monid) pass 20; then they are deferred, found with `tools_search` and run with `tools_call`. Under 20 there is no search or call, and Claude Code's own tool search follows the same threshold and gets neither of ours. `codemode`, `tools_search` and `tools_call` each have a tool-settings key (allow by default); a tool set to deny is not offered at all.
