---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
An escalated workflow run reads as waiting for a person, not as failed. Its `status` is `completed` (state `idle`), with `error` and `result.output` null, and a new nullable `review` on the run and on the runs list: `{kind, node, reason, at}`. `kind` is the escalation's kind as its escalate node names it, `node` is the label of the node it escalated at, `reason` is the escalation's summary, and `at` is when it ended. Every other run's `review` is null. The field is this server's own on the `/v2` document (`Run.review`, `RunSummary.review`, marked `x-agentrun-serve: review/1`). A run ended before this kept no review: it reads its row's summary as the reason, with kind and node null. A workflow run still takes no messages (501 `unsupported_here`). `readWorkflowRun` gains `escalation: {kind, label, summary}`.
