---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
The Learning tab says "About 7x cheaper at the same accuracy" only when it can back both halves: the ratio, and the replay the serving workflow was promoted on clearing the accuracy bar. Under it, one line: "Replay: workflow 95% vs agent 94% on 40 inputs · served 59 runs, handed back 3". With no replay yet, or one below the bar, it says "7x cheaper" and why accuracy is not claimed.
`GET /agents/{id}/learning/cost` no longer averages around runs whose cost isn't known. While any run the ratio reads (the agent's runs before the takeover, every run after) has an unknown cost, or a cost known only as an upper bound, `summary.times_cheaper` is null and `summary.withheld` names the counts ("3 runs' cost unknown, 1 known only as at most"). The summary also carries `replay` (the serving promotion's `n`, `workflow_pct`, `agent_pct`, `cleared`), and each run carries `cost_upper_bound`. `agentrun learning cost` and the CSV read the same rule; the CSV gains a `cost_upper_bound` column after `cost_usd`.
Upgrading: a script that reads the cost CSV by column position shifts every column after `cost_usd` by one.
