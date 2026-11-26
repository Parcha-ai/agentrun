---
packages: @parcha/agentrun-serve
kind: fix
---
`DELETE /v2/agents/{agent_id}/learning` now answers only once the clock is past the reset's watermark (the millisecond it began), so a run started right after its `204` always learns from what follows the reset. Before, a reset with nothing to wait for could answer in that same millisecond, and a run started at once read as one before the reset: it learned nothing (reason `reset`), an SDK start was refused, and `compile_after` did not count it. The answer waits at most a millisecond more.
