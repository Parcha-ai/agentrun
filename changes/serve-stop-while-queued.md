---
packages: @parcha/agentrun-serve
kind: fix
---
A stop works on a run that is working but still reads `queued`. A message sent to a run shows in its timeline only once the run's process reports it, so right after a start, on a loaded machine, a run well into its turn could still read `queued` (state `working`), and `POST /v2/runs/{id}/stop` answered `stopped: false`. The stop now waits, up to a request's deadline, until the run's timeline shows every message sent to it, then stops the turn as it stops any working run: `stopped: true`, and the run reads `input_required`. It waits for the timeline first so that what the stop records as the person's last message is the one the turn was answering, and the stop holds once that message shows. A run that ends, is cancelled or loses its process while the stop waits answers `stopped: false`, as before.
