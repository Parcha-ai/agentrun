---
packages: @parcha/pi-durable-agent, @parcha/agentrun-kernel
kind: fix
---
A claude-agent run whose tool call ended before its answer was paid (Claude Code's cost comes in after its response) stored the call's result before the call. Its timeline showed the result first, labelled without its argument, then an "interrupted" result for the same call when the run ended, and the run's tool metrics counted that call twice, once failed. The timeline and the metrics now match such a result to the call that comes after it: it shows after the call, with its argument, once; the call never reads as interrupted; and it counts once, under its call's name, by its call's tool's rule. Runs already stored that way read right too.
- `@parcha/agentrun-kernel/testing`: the faux harness's `calls` action takes `bookAfter: true`, which runs the calls before the answer's cost is booked, as with Claude Code.
