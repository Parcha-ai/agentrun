---
packages: @parcha/agentrun-serve
kind: fix
---
A run a server takes up after a restart, its process still going, never shows its browser sign-in's pointer: the server reads the agent's pointer back, read only and without taking the save lease, among the values the run's answers, errors and timeline never show. Before, only a launch by the same server added it, so a run kept across a restart could show it.
- A run's end-of-run learning refuses a note that holds its browser sign-in's pointer, as it refuses a held key, so the pointer never reaches the agent's learning.
- The line a run's end keeps in the agent store (its answer, or its error) is cut of the same values its served answer is, whole.
