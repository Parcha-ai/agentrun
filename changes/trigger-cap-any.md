---
packages: @parcha/agentrun-serve
kind: fix
---
A schedule whose `every_s` a hand edit of its store row put out of range (below 60 seconds, or past a year and a day) is turned off with `disabled: {reason: "source_unreadable"}` and a log line, as a cron line or zone that no longer reads is, instead of firing on a step no request could set.

Archiving an agent turns off every trigger that runs as it (a `start_run` of it, a `message_run` to one of its runs) in the archive's own store transaction, with `disabled.reason` `agent_archived`, and the archive's answer lists them in `triggers_off`. Unarchiving turns none on: its answer lists those still off. While the agent is archived, a trigger made on, turned on or aimed at it is `409 agent_archived`, and a firing that comes due anyway is skipped ("The agent <name> is archived.") and starts no run: the store refuses a run of an archived agent in the transaction that would start it.

A webhook trigger's view (create, GET, the list, PATCH) carries `hook_url`, where its sender posts: its own `/v2/hooks/{id}`, at the server's public URL when it has one, else the path. A schedule has none.

A webhook trigger that starts runs takes `max_active_runs` with or without `accept`. Set, each event starts its own run up to the cap; past it the firing waits due, and past 20 due an event answers `429 rate_limited` with `Retry-After`. Without a cap, a trigger with no `accept` keeps the overlap skip as before. A schedule keeps the overlap skip and still refuses `max_active_runs`, as does a `message_run` target, which starts no run.
