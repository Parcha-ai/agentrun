---
packages: @parcha/agentrun-serve
kind: fix
---
A run that answered and lost its runner's claim while looking back (its end-of-run learning turn) now ends completed with its answer. The claim that takes it over no longer runs the open learning turn as the job's turn: that turn is never told the cap's "finish now" note, and a cap refusal of its requests drops the learning as `no_budget` instead of parking the answered run for a raise. The runner beside a server now logs a lost claim and a failed renew in the runner's name, as the `runner` subcommand does.
A run's status is now how its job's own turn ended: learning spend that takes the run past its cap (its cut requests booked at their worst case included) drops that learning as `no_budget`, the spend still booked, and never fails the run; a compile turn the cap refuses is dropped the same way.
A run whose job failed (a tool call that faulted on every restart, an answer cut at the model's limit) and that lost its claim during its end-of-run learning now ends failed in the same words after the takeover, never completed: the job's end is kept before the learning starts and the takeover reads it.
Upgrading: a run that is in its end-of-run learning while its runner is upgraded, and loses its claim there, ends failed ("the end-of-run turn is open, but the job's end was never kept before it"), because the older runner never kept the job's end. Let running learning settle before upgrading a runner.
