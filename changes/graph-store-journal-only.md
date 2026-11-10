---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's graph (`GET /v2/runs/{id}/graph`) is read from the run's journal in the store, and nothing from the disk. Before this, the graph read `live.json` and `nodes.jsonl` from the server's working directory, so a run that was still going showed none of its calls, and a stray file there showed on every run's graph. A run's calls now come from the workflow engine's effect records: working while in flight, done with the call's input and output, failed in the tool's words, and stopped when the run ended first. Once a run has ended, its graph total is the run's own cost, so each call is counted once. A graph read that fails for its own reason now answers `internal` with fixed words instead of the error's text, which could quote what the read was parsing. The server log keeps the error with every quoted part left out.
