---
packages: @parcha/agentrun-serve
kind: fix
---
Schedules keep firing after a crash or a bad trigger. A trigger's firings are driven one at a time, in order, so a firing a crash left due settles to the run it had before the next start's own firing is checked, which then starts its run instead of being skipped as waiting on it. A trigger whose cron line or zone no longer reads (a newer cron library or time zone data refuses it) is turned off alone with `disabled: {reason: "source_unreadable", detail}`, at a start or when it comes due, and every other schedule goes on firing; the log names it instead of a failed write, and nothing is retried for it. A first start that sends `trigger.failed` takes failures an earlier server recorded as already told. A trigger's input is checked at create and PATCH as its runs are given it, with the line saying what fired it.
