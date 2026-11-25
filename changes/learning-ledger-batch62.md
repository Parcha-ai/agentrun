---
packages: @parcha/agentrun-serve
kind: fix
---
The money rule no longer serves a learned workflow unchecked. When the newest 500 runs hold no run by hand, the workflow is held to the 10 by-hand runs before them. With no by-hand cost, or past runs it can't read, the agent takes the run and the log says why; the learning view then says `stopped`, never `serving`.
- `GET /agents/{id}/learning/cost` says why the money rule stopped a workflow in a new `workflows[].reason`: `over_line`, or `no_by_hand_cost` when it served 10 runs and no run by hand has a priced cost. That second case used to read `serving` there.
- A run whose end named no path counts as a run by hand when its launch does not learn, both inside the window and before it. A run of a workflow revision never counts as one, in either place.
- A served run cut at its cap counts at its bound on the served side.
- A shadow that failed before naming what it audits still books its cost on that run.
- `/stats` and `/analytics` count a run whose shadow is at work or unpriced as unknown cost, as the cost page does, never $0.
