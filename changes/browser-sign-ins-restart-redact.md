---
packages: @parcha/agentrun-serve
kind: fix
---
A run a server takes up after a restart, its process still going, never shows its browser sign-in's pointer: the server reads the agent's pointer back, read only and without taking the save lease, among the values the run's answers, errors and timeline never show. Before, only a launch by the same server added it, so a run kept across a restart could show it.
