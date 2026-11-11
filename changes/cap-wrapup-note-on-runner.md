---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A run near its cap is told to wrap up again, on the runner, for every harness (part of #2080).
- Once what is left of the cap is about one typical request, the run's next model request tells the model, inside that request, to finish now ("This run's budget is about $X, …"). The note goes to the model only and never into the run's transcript.
- It is worked out from everything the run has spent and holds, including requests still in flight. A Claude Code or Codex run whose requests overlap is told on time, not late or never.
- It is told once per cap. A raised cap is told again when the run comes near the new cap.
- The Timeline shows the note as the server's row ("AgentRun: This run's budget is about $X, …"), written only once a request carrying it has been admitted.
- Kernel: `ModelPort` and the model proxy's hooks gain `noteReturned?(note)`. The proxy calls it when a request that took the host's note leaves before its admission (its client gone, a refusal, an error), so the host can give the note to the next request at once.
- Kernel, a change for anyone reading or implementing `ModelBooking`: it gains `heldUsd(): number | null`, the holds of the session's requests still in flight. It returns null (unknown, never 0) while one of them has no hold, and a reader must treat null as unknown. `spentUsd()` still counts answered requests only, so the run's total is `spentUsd()` plus `heldUsd()`.
