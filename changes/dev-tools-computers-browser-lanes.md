---
packages: @parcha/agentrun-serve
kind: feature
---
The console's Dev tools tab draws a run's computers and browser sessions on its time axis. Once the run's usage is read (`computer_intervals` and `browser_sessions` on `GET /runs/{id}/usage`), the overview has a lane for each under the calls, and the Breakdown lists each one: what it is and its size or its provider's id, when it started against the first request, how long it was up, how much of that is in the run's cost, and what else its record says (kept while the run waited for a person, closed by the agent, an attempt that was cut). A computer made before the first request or deleted after the last call is drawn open at that end. A run with neither shows no lane.
