---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's graph read again with the same held keys redacts nothing again (#2464). `GET /v2/runs/{id}/graph` reads only the run's facts (its kind, revision, status, times, and whether it is withheld), never the run's served view, whose output and words were redacted again on every read. Every top-level field of the graph, its name and its value, scalar or not, is cut once per content and held-key set and kept as cut, as its parts already were. A key saved since makes a new set, cut on the next read. The read's own `read_at`, the server's clock, is served as it is.
Upgrading: nothing to do.
