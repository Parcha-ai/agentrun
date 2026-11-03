---
packages: @parcha/agentrun-serve
kind: fix
---
A message sent while a stop is in flight is no longer lost. `POST /v2/runs/{id}/stop` sets its mark, then saves it and aborts the turn through the run's process. A message that came in that gap read the run stopped, went in as a follow-up to the turn the abort was cutting, and was dropped with it: pi withdraws the inputs it had queued, and a harness door hook drops its own queue. Its row never came, so the run read `working` for good and kept its place under `--max-runs` until a cancel or a restart. A message now waits, up to a request's deadline, for a stop in flight to answer, including one that began while the message itself was waiting (on the run's end, its reopening, or the agent store), then goes in as a follow-up to the stopped run and starts its next turn. `startServe` takes `beforeAbort`, a test's seam awaited by a stop between its mark and its abort.
