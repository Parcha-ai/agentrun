---
packages: @parcha/agentrun-serve
kind: feature
---
`monid.discover`, `monid.inspect` and `monid.run`: with `MONID_API_KEY` set, an agent on pi gets monid's whole catalog of paid data endpoints through three tools in the tool picker. It finds an endpoint in plain words, reads its input schemas and price, and runs it, paid per call from the monid wallet. A run is sent once and never retried; an async one is read until it ends (about two minutes at most) and stopped at monid when the run stops. An answer over 60,000 characters is cut, the whole of it filed under the run's `work/evidence/monid/`. The launcher hands `MONID_API_KEY` to the server and each run's process over their pipes, like the other secrets. pi only for now: a revision naming one on claude-agent or codex saves with a warning and its runs are refused.
