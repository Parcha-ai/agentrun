---
packages: repo
kind: feature
---
The console shows learning at work:
- On a run's Timeline, a learned workflow's call lists the nodes that ran, closed by default: how many ran and how many did not end ok, then each node's status (ok, failed, escalated), label, kind and time. A call with no nodes reads as before.
- In the agent's Learning tab, a learned workflow opens as a graph, drawn with the same workflow graph a workflow agent's tab draws, with its workflow.json under it. A text that is not a workflow shows as text, as before.
- A run's page (Report and Timeline) says what it used of what its agent learned: each learned skill it was given, read or not, and each learned workflow it called, how many times and how many of those failed. Nothing shows when it was given no skill and called no workflow.
- The before and after counts runs that started from a learned skill or workflow as it counts those that started from a note, and its words name all three.
Upgrading: nothing to do; the run page reads `GET /v2/runs/{id}/learning` for a run that learns.
