---
packages: @parcha/agentrun-client
kind: fix
---
A `runs.wait` (or any call with a deadline) whose timer fires a fraction of a millisecond before the clock reads the deadline now ends in `AgentRunTimeout`, never `AgentRunRefused` or `AgentRunUnreachable`. The deadline is reached when its own timer fires, not only when `Date.now()` says so.
- Upgrading: nothing to change.
