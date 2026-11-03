---
packages: @parcha/agentrun-serve
kind: fix
---
A run cancelled while it works now reads `cancelled` as its first terminal status even when the turn the cancel cut puts it over its cap. Before, the server's check over the run's cost came ahead of the cancel: a cost that came in with the cut turn's end published `failed`, and the run then ended `cancelled`. A cancel the server took now decides the run's end before anything else does.
