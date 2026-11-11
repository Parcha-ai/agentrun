---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run on the runner whose decision's provider reported no cost now saves its cost as unknown, not as the decision's hold. The run's end cost read the cap's own figure for its decisions, which counts a decision of no reported cost at its hold, so a run saved the hold (a guess) as a known cost. It now reads its decisions' cost from their booking records, as a pi or CLI run does: an unknown charge leaves the run's cost unknown. The cap still counts such a decision at its hold, so the run's cap is kept as before.
