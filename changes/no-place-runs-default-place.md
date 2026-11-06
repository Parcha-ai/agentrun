---
packages: @parcha/agentrun-serve
kind: breaking
---
A revision that names no place runs where `capabilities.places.default_place` says, worked out at each run the same way as at create. An agentic revision runs in the Docker box wherever this server has docker now, and on the runner where it does not. A workflow, and a revision whose tools name one the box refuses (`browser`), run on the runner. A save checks a revision with no place against where it would run, so `bash` with no place saves where docker is there. `capabilities.places.default` is gone: `default_place` is the one field for where a new agent goes and where a revision with no place runs (`x-agentrun-serve: "place/4"`). The console reads `default_place` for both, and an agent page with no place says it runs where the server's default place is.
Upgrading: an agent saved with no place on a server that has docker now runs its next run in the Docker box, not on the runner. To keep it on the runner, save its definition with `"place": {"mode": "runner"}`. A client that read `places.default` reads `places.default_place.mode`.
