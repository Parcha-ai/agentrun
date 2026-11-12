---
packages: @parcha/agentrun-serve
kind: fix
---
A stop wins over a run's first input and over two answers that still slipped past it.
- A run stopped or cancelled before it started now ends at its runner's claim. No loop starts, and its first input never reaches the model, so it is never billed. This covers a run claimed from queued, and one whose earlier claim was lost before its journal had anything. Before, the runner started the run's loop first, and the input could go out before the stop was applied.
- An answer to a waiting call is now 409 `already_answered` (decision `withdrawn`, or `canceled` for a cancel) in two more cases where it never runs. One: the run's stopped end took the stop and refused the answer before the answer read back. Two: the answer is a retry of one written behind a stop the runner has not taken yet. Before, both were answered 204.
