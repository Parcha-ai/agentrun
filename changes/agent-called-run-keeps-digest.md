---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose agent called its learned workflow itself, and that the workflow answered or handed back, now names the revision that ran: `workflow.digest` on GET /runs/{id} and each runs list row, `runs[].digest` on GET /agents/{agent_id}/learning/cost, and `workflow_digest` on its grade. Before, only a run the platform served first did, so such a run read `digest: null` though its `workflow_calls[].digest` named the revision, took no share of that revision's compile and check spend, and was never the run where the workflow took over. It now counts as a served run of that revision wherever a platform-served run does: its share of the spend, the cost page's takeover, and the audit's served-run counts and grade rows. A connected agent's run, whose events keep no call record, still names no digest.
