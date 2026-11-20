---
packages: @parcha/agentrun-client, @parcha/agentrun-serve
kind: fix
---
A connected agent's shadow check now reserves a native turn only when the draft takes its input: a JSON task must pass the draft's input schema, and a start whose task or instructions held a protected value reserves nothing. A turn that cannot be the check's baseline (cancelled or failed, a learned workflow in it, redacted evidence, no shadow report, or a shadow that failed or stopped at an unrecorded write) gives its reservation back instead of holding the draft, and the next turn the draft takes is checked. The fifth given-back turn stops the check with nothing checked, which asks no recompile. A start that could not be admitted gives its turn back uncounted.

A turn the backend never completed within the hour is decided like any other check, as one failed input: its hold asks the one recompile, and a recompile's check that ends the same way stops instead of compiling again. A draft still waiting for a turn when a newer revision lands is set aside, and the newer revision is checked.

Promotion records of connected checks say `via: "sdk"`, and their check records count `released` turns and the shadow's `fresh_reads` (live read-only calls it made where the recording had none, which the client now reports). A failure to settle a check no longer skips the run's own end or its learning.
