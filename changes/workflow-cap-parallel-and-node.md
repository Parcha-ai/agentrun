---
packages: @parcha/agentrun-serve
kind: fix
---
A capped workflow pauses at its cap on the runner as it should:
- A capped workflow run with a Parallel decision no longer fails "spend_cap_reached: Not sent: the next model request's model has no price here". Parallel charges by the request, and its decision was priced as a model with no price. Now it is held at its request price, and a cap too small for it pauses the run for a raise.
- A workflow paused at its cap names the model node whose request waits (`pending.node`), from the one step under way; `null` when several run at once.
- A workflow paused again at a higher cap (a raise that did not cover the step) tells its owner's webhook again (`run.needs_input`). Waits at one cap are still told once.
- Upgrading: nothing to change.
