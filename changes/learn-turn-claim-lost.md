---
packages: @parcha/agentrun-serve
kind: fix
---
A run that answered and lost its runner's claim while looking back (its end-of-run learning turn) now ends completed with its answer. The claim that takes it over no longer runs the open learning turn as the job's turn: that turn is never told the cap's "finish now" note, and a cap refusal of its requests drops the learning as `no_budget` instead of parking the answered run for a raise. The runner beside a server now logs a lost claim and a failed renew in the runner's name, as the `runner` subcommand does.
