---
packages: @parcha/agentrun-serve
kind: fix
---
A schedule whose `every_s` a hand edit of its store row put out of range (below 60 seconds, or past a year and a day) is turned off with `disabled: {reason: "source_unreadable"}` and a log line, as a cron line or zone that no longer reads is, instead of firing on a step no request could set.
