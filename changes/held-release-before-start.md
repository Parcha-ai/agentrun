---
packages: @parcha/agentrun-serve
kind: fix
---
A held computer's run released before its owner started it now always ends cancelled with its agent never run. Before, a release that reached the runner just as it took up the run (after the hold began waiting, before the runner's wait for the start) was missed: the agent ran and the run ended as a plain completion.
