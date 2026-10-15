---
packages: repo
kind: feature
---
The reference entry honors `Fakes.extensions` and `Fakes.vision(host, running)` on a no-key run, takes a `result(record, { dir, keep })` hook that writes the recording's result (`agentrun.cited/1`) from what a demo makes, hands tools `ToolContext.live`, uses a local box instead of Docker on fakes (Docker only with `--live`), and refuses `--input` naming another project on fakes unless its capture exists under `fixtures/` beside the demo.
