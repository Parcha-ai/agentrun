---
packages: @parcha/agentrun-client, repo
kind: feature
---
Add opt-in learning wrappers for existing Claude Agent SDK queries and Codex SDK clients. Preserve the application's original SDK events, results, tools, options and cancellation while supplying checked notes and skills to fresh tasks. Cookbooks and opt-in live examples verify real tool execution, accepted learning and fresh-run reuse against a learning-Off control.
Codex streaming queues evidence uploads without delaying native events or cancellation; completion drains the ordered queue and `flushLearning()` reports persistence failures.
The live examples recognize accepted user preferences as well as run-derived notes before checking fresh-run reuse and the learning-Off control.
