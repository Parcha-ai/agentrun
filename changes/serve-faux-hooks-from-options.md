---
packages: @parcha/agentrun-serve
kind: fix
---
serve's test hooks (`AGENTRUN_SERVE_FAUX`, `AGENTRUN_SERVE_FAUX_HARNESS` and every name after that prefix) are set from `startServe`'s options alone. A name in the server's own environment is dropped from what the server reads and from every run's process. Before, a published server honoured these names from its environment with no option: a leftover export gave every run fake answers or loaded a module by path.
