---
packages: @parcha/agentrun-decisions
kind: fix
---
`openrouterProvider`'s image check now runs inside the request's deadline and ends on its cancel. Before, the first image request to a model other than Jev waited for `takesImages` before its deadline started and without looking at the run's signal. The catalog read behind it has its own 10 s bound, so a cancelled or shorter request waited up to 10 s, and a host's `takesImages` that never returned held the request forever. A check the run's cancel cuts fails `aborted`, and one the deadline cuts fails `timeout`. Nothing was sent in either case. The catalog read is shared, so it runs on for the next request.
