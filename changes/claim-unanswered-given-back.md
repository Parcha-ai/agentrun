---
packages: @parcha/agentrun-serve
kind: fix
---
A runner whose claim commit the store's Postgres left unanswered no longer leaves the run stuck for the lease. The claim may have landed, so the runner reads back what it holds (`runs.claimsOf`, judged on the store's clock), retrying the read with a doubling wait, and releases at once any claim of its own that nothing holds, fenced on its epoch, so another runner (or this one, on its next poll) takes the run. A release answered Unanswered is read back the same way and sent again only if the claim is still held at its epoch.
