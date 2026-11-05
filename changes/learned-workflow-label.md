---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow's call reads on a run's timeline as the workflow it ran and what it gave: "Ran the learned workflow price-report", then "Ran the learned workflow price-report: total 49.75", its output in one line through the same redaction as any tool's summary. It read "Using tool: learned_workflow" / "ok" before.
