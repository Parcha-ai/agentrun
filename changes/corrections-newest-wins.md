---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
A correction appended to an agent's `corrections.md` that would take the file past its cap now drops the oldest lines instead of being refused. If you relied on old corrections staying until an owner removed them, keep your own copy.
The cap is now 8192 bytes (was 2048), and the newest correction always reaches the next run's `# Learned`. The run's learning (`GET /runs/{id}/learning`) gives the number of lines dropped in a new `dropped_lines` field, and its `detail` says it too. A correction whose own line is over 8192 bytes is still refused, and so is an owner's whole-file `PUT .../learning/corrections` over the cap: nothing is dropped for an edit. Before this, one follow-up correction wrapped the way a host wraps it (about 2 KB) filled the file, and every later one was dropped with `too_large`.
