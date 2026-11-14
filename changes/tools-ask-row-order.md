---
packages: @parcha/agentrun-serve
kind: fix
---
A call that waited for approval now reads in the order it happened, on every harness: the call, then the "Asked your approval" row, then the call's result, then what came of it. The approval row carries the time the approval was asked (the run's `pending.requested_at`), not the time of the call's result. Before, it sat below the result and carried the result's time.
