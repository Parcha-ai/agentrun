---
packages: repo
kind: feature
---
The console's agent page has an Analytics tab, on a server whose `GET /v2/stats` answers `analytics` (an older server's page shows no tab). For one agent, over the last 7 or 30 UTC days or every run, it shows tokens with the cached share and output, wall and active hours, runs with their success rate, the cost (unknown is never $0), runs, success, tokens and cost by effort, the top tools with their error rates, and runs per day with a table view. It says plainly when some runs have no metrics, and when model requests reported no token counts.
