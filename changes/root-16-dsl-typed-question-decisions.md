---
packages: repo
kind: feature
---
`@parcha/agentrun-dsl` records typed-question decisions. A host that supplies `recordDecision(receipt, exchange)` gets one `DecisionReceipt` per request (`judge`, `pick`, `sift`, `route`, an `ask` predicate, a `verify` review), awaited before the answers reach state, an event or a branch; a rejection fails the node with `WorkflowDecisionRecordError`. A receipt holds the questions, the answers, the rule with its thresholds and the action, and `rederiveDecision(receipt)` recomputes the action without a model call. See "Decision receipts" in `docs/host-integration.md`.
- The decision events carry the receipt's id: `decision_id` on `judge.answered`, `route.chosen`, `ask.evaluated` and `verify.answered`, and `decision_ids` (one per request) on a sift's `judge.answered`. `runJudge` receives it as `decisionId`. The id is the request's identity, so the same request asked again has the same id.
- A sift split over the host's limits records one receipt per request. When one request fails, the requests in flight are recorded as `cancelled`, and a split sift now refuses a request's answers as soon as they arrive instead of after every request has returned.
- `recovery.decision(id)` answers a request from the receipt an earlier run recorded. Before, a resumed run asked again: a loop's `until: ask` could end the loop on an earlier pass's state after later passes had run, and a route could take another branch than the one already started. With the hook, both follow the recorded decision.
- No change for a host that supplies neither hook, except the new event fields.
