---
name: broken
version: 0.0.1
description: Two schedules; the second is a date that has passed, which only an apply can tell, so applying it makes nothing.
budget: { per_run_usd: 0.25 }
triggers:
  - name: Fine
    source: { kind: schedule, cron: "0 9 * * *" }
    target: { kind: start_run, input: { content: Go. } }
  - name: Refused
    source: { kind: schedule, at: "2020-01-01T00:00:00Z" }
    target: { kind: start_run, input: { content: Go. } }
---
Answer.
