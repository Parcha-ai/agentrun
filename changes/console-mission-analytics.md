---
packages: repo
kind: feature
---
Mission Control shows a run's tokens, time, tools and success, not only counts and cost, when the server answers `GET /v2/stats` with `analytics`. A server without it shows the page as before.
- Tiles for tokens (with the cached share of input and the output), run time (wall time of ended runs, and active time where the metrics have it), success rate (completed against failed or escalated) and cost. When some runs have no metrics, the tokens say so ("tokens from 9 of 12 runs"), and the requests that went uncounted are named.
- A per-day trend of the range, at most the last 30 days: runs stacked as completed, failed and other, and tokens, each bar with a readout on hover and focus, plus a table view. Success, tokens and cost by harness and effort, and the top tools with their error rate. Imported runs are counted apart from the ones run here.
- A range picker (7 days, 30 days, all) and an agent picker, which ask the server again. A cost no run reported reads Unknown, never $0.
