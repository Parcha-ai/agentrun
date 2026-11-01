---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run's spend cap refuses once what the run has spent is unknown, as claude-agent's and codex's already did, and a model whose output is priced but that names no output ceiling is refused under a cap on every harness.
- The spend a pi run's process reads back from its store at start is the run's own timeline cost, so every rule the timeline keeps for an unknown cost holds: a request or compaction marked as sent with no answer (a crash cut it), an answer stopped before its end, a cost that is not a number, a cost still pending. Before, each of these counted as $0, and a capped run kept spending past what it could count. Now every later request is refused with `spend_cap_reached`, and so is every request after an answer in the same process whose cost is unknown. A capped pi run whose request was stopped mid-answer therefore cannot send another.
- A model with no output ceiling (no max output tokens and no context window) was priced at no output, or at a worst case that was not a number and passed every check. Under a cap it is now refused with `spend_cap_reached`, unless its output costs nothing at every price tier, which keeps a known worst case. No model in pi-ai's catalog, and no gateway model serve builds, is affected.
