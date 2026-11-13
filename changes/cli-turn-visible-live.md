---
packages: @parcha/agentrun-serve
kind: fix
---
A claude-agent or codex run's turn is visible while it runs, as a pi run's is: `GET /runs/{id}` reads `working` with a `last_progress_at` that advances as the turn writes calls and results (never `working`/`idle` with none), and the model's answer is on the timeline as soon as its request is over, not at the end of the turn. A turn that fails with a message queued behind it keeps its error in the timeline and goes on to the queued message's turn, so the run ends with that turn's status. A turn the harness ends interrupted on its own, with no stop and no error, leaves the run `input_required` (a message goes on) instead of failing it with "the run gave no answer (interrupted)". A cancel accepted before such a stop is stored still wins it: the run ends `cancelled` and takes no further message.
