---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A claude-agent run whose tool call ended while the model's answer was still streaming showed the call's result before the call, labelled without its argument, then an "interrupted" result for the same call when the run ended, and the run's tool metrics counted that call twice, once failed. The result is now stored right after the answer entry that holds its call.
- `@parcha/agentrun-kernel/testing`: the faux harness's `calls` action takes `bookAfter: true`, which runs the calls before the answer's cost is booked, as Claude Code runs a call while its response still streams.
