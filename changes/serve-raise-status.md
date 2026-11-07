---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose cap is raised at its pause reads `queued` the moment the raise is taken, in the PATCH's answer and every read
after it, until its follow-up turn runs. It no longer reads `input_required` with `pending: null` while the paused process
is let go, which `agentrun runs wait` and the client's `runs.wait` took as a run waiting on a person.
