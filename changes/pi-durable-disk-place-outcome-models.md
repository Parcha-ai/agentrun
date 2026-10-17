---
packages: @parcha/pi-durable-disk
kind: feature
---
**A place's outcome carries the models the run's live parts chose (`PlaceOutcome.models`)**
- `PlaceOutcome.models?: Record<string, string>`: the role-to-model ids (`lead`, `eyes`, ...) the app reported, on any
  outcome status, so a supervisor's manifest names the models of a remote run as of a local one.
- `archilPlace` reads it from `run.json`'s final status detail (`detail.models`); `localPlace` from the instance's
  `{"outcome":...}` line, or from `run.json` without one.
- Both keep it only when it is a plain object whose values are all strings. A missing or malformed one is left out, never
  replaced by `{}`. Before, `localPlace` passed the outcome line's `models` through unchecked, a malformed one included,
  and `archilPlace` never carried it.
