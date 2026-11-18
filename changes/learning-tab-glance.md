---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Learning tab opens on what learning did, once a learned workflow has taken a run over: one sentence, then four figures, each with the count it stands on. The cost ratio is the server's own; how often the serving revision's answer was the agent's, and how many of the runs it ran first it finished alone, are shares with their 95% interval; the last is the bill's break-even run.
- A new chart, cost against agreement, draws each promoted revision as one point: what a run it served cost, all in, against how often its answer was the agent's on its check's inputs and its audited runs, with that share's 95% interval, the bar it had to clear to serve, and the agent as the reference at what a run cost it before takeover. It sits beside the bill.
- Who finished each run is drawn a run a column wherever the chart is wide enough to give each run one, so a hand-back shows on its own run; a narrower chart keeps blocks of runs.
- Agreement is never called accuracy: the agent's answer is the reference, not the truth. The tab reads the audit ledger once for the figures, the chart and the audit line. No API changes.
