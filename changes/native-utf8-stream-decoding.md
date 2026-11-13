---
packages: @parcha/agentrun-serve
kind: fix
---
Preserve native Claude Code and Codex UTF-8 answers, tool arguments and tool results when a pipe splits a character between chunks, including remote source bridges. Incomplete trailing output still fails visibly rather than disappearing.
