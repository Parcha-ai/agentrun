---
packages: @parcha/agentrun-serve
kind: feature
---
A run's browser that its owner took over in the live view now reads `computer.state: "taken_over"` on GET /v2/runs/{run_id} and GET /v2/computers/running, as a desktop or a phone does, so Settings → Computers → Running now shows "You drive" for it. Before, a browser always read `ready` there while its owner had it. The run's process keeps one setting per run while the take is live and removes it as the take ends, as a browser session opens, and at the run's end.
