---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, repo
kind: feature
---
Wrapped links each harness's numbers to the runs of every source behind it (`#/runs?source=<source>`), and says "not imported yet", with the import command, for a source with no imported runs. `GET /v2/wrapped`'s harness rows gain `sources` (the sources read for that harness: several can share one), so the console needs no copy of the source-to-harness table. The page also holds the registry of the nine prototype cards (what each reads and waits on) and a renderer seam; with no renderer it shows no cards section.
