---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: ci
---
The two harness adapters list `@parcha/agentrun-dsl` as a dev dependency, since only their tests import it, and serve's package keywords drop the retired `pi-durable`.
