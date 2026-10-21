---
packages: @parcha/agentrun-harness
kind: fix
---
A demo whose `demo.json` declares a required program (`programs`: `{ cmd, why, required }`) that is not on this machine's `PATH` is refused before anything starts, and the error names each missing program and what it is for. A run on fakes still runs the agent's own commands, so before this a missing `pdftoppm` or `ffmpeg` ended the free vision demo as `the model did not answer (model_error)`. Programs needed only for `--live` are checked only on a live run, and a demo that brings its own place is not checked here.
