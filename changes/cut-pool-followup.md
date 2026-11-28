---
packages: @parcha/agentrun-serve
kind: fix
---
A cut read of a run's file (`GET /v2/runs/{run_id}/files/{path}?cut=run`) whose cut worker can't be started is refused at once with the retryable `503 unavailable`. Before, the first such read failed with a raw error instead of the 503, and a read queued behind another one threw out of the timer or worker message that started its cut, which ends the server. The read's 5 s deadline for its cut is counted on the monotonic clock, so a wall clock set forward during a read no longer refuses it with a 503. The deadline counts from when the file's bytes are in hand.
