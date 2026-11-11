---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
Installing `@parcha/agentrun-harness-claude` or `@parcha/agentrun-harness-codex` no longer installs `@parcha/agentrun-dsl`: neither adapter imports it at run time (only their tests do), so it moved to their development dependencies.
