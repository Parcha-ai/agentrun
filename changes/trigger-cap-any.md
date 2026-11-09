---
packages: @parcha/agentrun-serve
kind: fix
---
A schedule whose `every_s` a hand edit of its store row put out of range (below 60 seconds, or past a year and a day) is turned off with `disabled: {reason: "source_unreadable"}` and a log line, as a cron line or zone that no longer reads is, instead of firing on a step no request could set.

A webhook trigger that starts runs takes `max_active_runs` with or without `accept`. Set, each event starts its own run up to the cap; past it the firing waits due, and past 20 due an event answers `429 rate_limited` with `Retry-After`. Without a cap, a trigger with no `accept` keeps the overlap skip as before. A schedule keeps the overlap skip and still refuses `max_active_runs`, as does a `message_run` target, which starts no run.
