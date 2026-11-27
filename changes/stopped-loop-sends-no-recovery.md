---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run's loop stopped for a shutdown or a lost claim sends no more model requests. A turn's recovery that the run's browser release set running after the stop wrote a failed answer (`Connection error ... ECONNREFUSED`) to the run's transcript and a "Model request failed" row to its timeline, its session's model proxy already closed. The recovery now waits, unsent, for the claim's end, and the run's next claim makes the request.
