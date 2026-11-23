---
packages: @parcha/agentrun-serve
kind: breaking
---
Launch hook: a host's start for a handed firing (`trigger_firing`) with `revision`, `hold` or `hold_minutes` is now refused with 422 `not_allowed`, naming the field. In 0.1.0-beta.53 they were taken, so a host could start the firing's run on another revision of the agent, or hold its computer. The run starts on the trigger's target, on the agent's current revision. A host that sends them drops them from that request.
