---
packages: @parcha/pi-durable-agent
kind: fix
---
`runMetricsOf` never returns metrics the agent store refuses, whatever tool and model names a run's entries hold. A model can make up a tool name of any length, and as many as it likes: a run's end with those metrics was refused (`invalid`), and so was an import. A name longer than 256 characters is now cut to its first 255 and "…", so the same name is always the same key, and a lone surrogate reads as U+FFFD. A run keeps its 100 busiest tools and 100 busiest models; the rest are summed under `…other tools` and `…other models`, and a tool result with no name counts under `…unnamed tool` (it was `tool`). No entry's name is one of those three: a name that starts with "…" gets another. `METRIC_NAMES` from `@parcha/pi-durable-agent/timeline` holds the limits and the three names.
