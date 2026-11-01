---
packages: repo
kind: feature
---
The console's agent page has an Analytics tab, on a server whose `GET /v2/stats` answers `analytics` (an older server's page shows no tab). It shows one agent's tokens, time, success, cost, success by harness and effort, top tools and runs and tokens per day, over the last 7 or 30 UTC days or every run, drawn with Mission Control's analytics components and wording: a token sum says how many runs it holds, unmetered requests are named, and a cost not known is never $0.
