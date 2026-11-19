---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A run (GET /v2/runs/{id}) and each row of a runs list carry one `path` and a `workflow: { name, digest }` (the learned workflow that served it, null on any other run) in place of `served` and `handed_back`; the cost read's `bill` drops `baseline` and `promoted` (`summary.before` and `summary.takeover` say the same). Upgrading: read `path` and `workflow` where you read `served`/`handed_back`, and `summary.takeover`/`summary.before` where you read `bill.promoted`/`bill.baseline`.
