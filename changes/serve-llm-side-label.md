---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow's `llm` call is marked and costed in its run's store as request `llm`, its own side request, never as a compaction's summary (`compaction`), which the timeline and the cap's typical cost read as one.
