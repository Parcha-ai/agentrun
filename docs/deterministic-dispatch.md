# Dispatch a stored decision

`dispatch` selects a named branch from an existing string at `valuePath`. It makes
no model call. Use `judge` to produce a typed choice, or code to apply a policy to
raw probabilities, then dispatch that result. `route` remains a fresh semantic
judgment and is not a substitute for deterministic branching.

```json
{
  "node": "dispatch",
  "label": "apply decision",
  "valuePath": "policy.action",
  "branches": {
    "proceed": {"body": {"node": "code", "label": "proceed", "code": "s => ({action: 'proceed'})"}},
    "withhold": {"body": {"node": "code", "label": "withhold", "code": "s => ({action: 'withhold'})"}},
    "clarify": {"body": {"node": "code", "label": "clarify", "code": "s => ({action: 'clarify'})"}}
  },
  "otherwise": "clarify",
  "as": "applied"
}
```

Branches must be nonempty and each has exactly one body. A matching string selects
only its own branch. An absent value or an unknown string selects `otherwise` when
declared, and otherwise fails before any branch runs. Non-string values always
fail: the interpreter never coerces a number, boolean, object or null into a label.
Code can explicitly map those values to an action string when appropriate.
Branch coverage is enforced at runtime; the engine does not infer exhaustiveness
from an upstream schema or silently invent a default.

The optional `as` records `{value, taken, fallback}` before the selected body
executes; absent input is represented as null. No answer sidecar is created. The
original judge answer remains unchanged. Existing `requires` checks run first.
Branch bodies can themselves contain model calls or effects.

Children execute at `/branches/<escaped-name>/body`. Dispatch checkpoints its
aggregate state, and location-aware recovery handles composed child workflows.
Parallel write checks inspect every declared branch. Reports and terminal
artifacts remain outside branches. Author policy and capability checks inspect
all branch bodies before execution.

Validation covers the TypeScript runtime, editor schema, author contract,
inspection, recovery and Pi observation. Lean models deterministic selection and
the selected continuation; shared fixtures compare both interpreters. Proofs
concern control flow under arbitrary branch bodies, not model accuracy or task
authorization. Thresholds remain explicit authored policy in code.
