---
packages: @parcha/agentrun-serve
kind: feature
---
A run's desktop or phone can be watched and taken over by its owner: `GET /v2/runs/{id}/computer` answers its kind, its state (`live`, `none` or `off`), whether the owner holds it, and the provider's live stream of its screen (view-only while the agent works). `POST /v2/runs/{id}/computer/take-over` gives the owner a stream that drives it and parks the agent's screen, input and phone calls; `POST .../hand-back` gives it back. At the hand-back a parked look runs on the screen as the owner left it, and a parked act is not done: the agent is told the person had the computer and to look again. A take-over goes back to the agent on its own after 15 minutes, or at the run's end. Owner-only, as a run's browser view is: the console's password session, never a token. The browser keeps its own routes.
