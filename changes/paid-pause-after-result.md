---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose paid tool call the cap refuses for room reads waiting on a raise only once the call's "Not sent: …" result is on its Timeline. The pause was journaled inside the call, before the harness stored its result, so for a moment the run showed its budget card with no row saying which call was refused. The pause now lands at the model's next request, as a refused model request's does.
