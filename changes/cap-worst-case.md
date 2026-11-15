---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-client, @parcha/agentrun
kind: breaking
---
A run's cap is never passed: every model request is held at its worst case, its whole input priced uncached (at the cache-write rate when that is dearer), so a cache miss can no longer take a run past its `max_cost_usd`. The `expected` cap mode, which priced the input from the previous request's cache and let a miss go over by a bound, is gone, and with it the `cap_mode` setting.
- Breaking: `cap_mode` is gone from the run start body, the agent definition and the run. A run start that sends it is `422` with `{"field": "cap_mode", "reason": "not_allowed"}`; a definition that sends it is `422` with `definition.cap_mode` `not_allowed`. Drop the field; every run now behaves as `strict` did. A stored agent revision or run launch that still holds a cap mode is read as if it had none.
- Breaking: `cost.overshoot_bound_usd` and the budget pause's `overshoot_bound_usd` are gone from the run's view. The generated TypeScript and Python clients and the CLI (`--cap-mode`) lose them too.
- A request is not parked for want of room to answer: its output is clamped to what the cap has left after its input at the worst case, and it is refused only when that input plus the least answer (1,024 tokens) does not fit. The in-flight hold and the CLI harness's reserve for its answer are counted at the worst case too.
- A run whose requests read the cache spends less than it is held at, so it pauses earlier than under `expected`: raise the cap by the cached share of its input if a run that used to finish now pauses.
- Kernel: `CapMode`, `RecentRequest`, `CapOptions.mode`, `Admission.boundUsd`, `RefusalFigures.boundUsd`, `DECISION_OUTPUT_TOKENS` and `ModelRequest.inputTokensCounted` are gone. A decision is held at its model's most completion tokens.
