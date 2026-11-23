---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/computers/running` lists the computers up now: one row for each run still going (queued, working, paused or waiting on its person) whose agent has a computer, with the run's id, agent, title, status and state and its `computer` as the run read carries it (`starting`, `ready`, `taken_over`, and a held run's hold), newest first. The runs list carries no computer, so this is the one read across runs and agents; it costs a run read for each such run and nothing for a run with no computer. It takes the server's token like `GET /v2/computers`, and an API-only server serves it.
The console's Settings → Computers opens on it as Running now: each run with its agent, the computer's kind and provider, its state and what a waiting run waits on, and a link to the run, whose Screen tab is the live view. It is read when the page opens and every 10 seconds after.
