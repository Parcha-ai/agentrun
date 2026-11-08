---
name: broken
version: 0.0.1
description: Two schedules; the second's input is one this agent cannot take, which only an apply can tell, so applying it makes nothing.
budget: { per_run_usd: 0.25 }
triggers:
  - name: Fine
    source: { kind: schedule, cron: "0 9 * * *" }
    target: { kind: start_run, input: { content: Go. } }
  - name: Refused
    source: { kind: schedule, cron: "0 10 * * *" }
    target: { kind: start_run, input: { content: 5 } }
---
Answer.
