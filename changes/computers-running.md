---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/computers/running` lists every run still going (queued, working, paused or waiting on its person) whose agent has a computer, newest first, each as `GET /v2/runs/{run_id}` answers it, so each carries its `computer` (`starting`, `ready` or `taken_over`, and a held run's hold). The runs list carries no computer, so this is the one read across runs and agents; it costs a run read for each such run and nothing for a run with no computer. It takes the server's token like `GET /v2/computers`, and an API-only server serves it.
The console's Settings → Computers opens on it as Running now: each run with its status as the run lists say it, its agent, the computer's kind and provider, You drive while you have it, and its hold; a row opens the run. It is read when the page opens and every 10 seconds while the page is shown.
