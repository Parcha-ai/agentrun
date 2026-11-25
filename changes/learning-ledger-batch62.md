---
packages: @parcha/agentrun-serve
kind: fix
---
The money rule no longer serves a learned workflow unchecked. When the newest 500 runs hold no run by hand, the workflow is held to the 10 by-hand runs before them. With no by-hand cost, or past runs it can't read, the agent takes the run and the log says why; the learning view then says `stopped`, never `serving`.
- A served run cut at its cap counts at its bound on the served side.
- A shadow that failed before naming what it audits still books its cost on that run.
- `/stats` and `/analytics` count a run whose shadow is at work or unpriced as unknown cost, as the cost page does, never $0.
