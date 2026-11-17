---
packages: @parcha/agentrun-serve
kind: fix
---
`scripts/dial-conformance.mjs` creates no machine until its public address reaches it. Its `GET /v2/health` now carries the run's id in `x-dial-conformance-run`, and the script asks `AGENTRUN_PUBLIC_URL/v2/health` once a second until three answers in a row carry that id, for up to 10 minutes. A host that swaps instances, such as Render on a deploy, keeps answering from the previous process for a while. Before this, a machine that dialed in that window was refused its token there (401) and never joined, so every Core case failed with "create did not answer within 180 s". While it waits the script says so, and it says how long the wait took. If the address never reaches it, the run fails in words without creating anything.
