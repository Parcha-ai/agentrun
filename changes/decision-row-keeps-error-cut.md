---
packages: @parcha/agentrun-pi, @parcha/agentrun-serve
kind: fix
---
A decision's row in a run's store keeps its receipt's `error_truncated`, so a completed run's decision error stored cut at 64 KB is still held back at its tail on the graph, where a held value the cut split would sit.
