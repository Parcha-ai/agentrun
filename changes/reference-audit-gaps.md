---
packages: repo
kind: feature
---
The reference entry honors `Fakes.extensions` and `Fakes.vision(host, running)` on a no-key run, takes a `result(record, { dir, keep })` hook that writes the recording's result (`agentrun.cited/1`) from what a demo makes, hands tools `ToolContext.live`, uses a local box instead of Docker on fakes (Docker only with `--live`), and takes `--input <name>` for a capture named in `demo.json`'s `input.fixtures` (a map from a name to a JSON file under `examples/<demo>/fixtures/`, read as the input); on fakes a name that is not a capture is refused with the list of captures, and a path outside `fixtures/` is refused.
A live child is given exactly the environment names `demo.json` declares (keys, `oneOf` members, programs) and nothing undeclared; `LiveParts.vision` takes `(host, running)` like `fakes.vision`.
