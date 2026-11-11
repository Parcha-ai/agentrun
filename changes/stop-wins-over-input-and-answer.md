---
packages: @parcha/agentrun-serve
kind: fix
---
A stop wins over two things that used to slip past it.
- A run stopped or cancelled while it was still queued now ends at its runner's first claim. No loop starts, and its first input never reaches the model, so it is never billed. Before, the runner started the run's loop first, and the input could go out before the stop was applied.
- An approve or deny of a waiting tool call written behind an untaken stop or cancel is now 409 `not_continuable` (`already_answered`, decision `withdrawn`, or `canceled` for a cancel), and the call never runs. This also holds when the answer's write lands just after the stop's. Before, it was answered 204 although the runner stops at the stop row and never acts on the answer. An answer written before the stop still runs: the first write wins.
