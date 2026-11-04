---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A Claude or Codex turn the person stopped stays stopped when the run's process is replaced. Before, the next process found the stopped turn still open in the session and resumed it: it ran its tools and paid for its model requests again, and its answer came before the person's follow-up. Now serve's open reads the run's stop record and settles that turn, ended `interrupted`, with nothing sent, and the follow-up is a turn of its own. A turn a crash or a drain cut is resumed as before.
- A stop that lands before the harness took the person's message withdraws that message too, so it is never sent later: not with the follow-up in the same process, and not by a process that replaces it.
- `AdapterSession` has `settleOpenTurn()`: it records the open turn as ended, interrupted, withdraws the input the turn never placed, and sends nothing. The Claude Agent, Codex and faux adapters implement it. A harness that runs as a child process does both with `settleTurn(drive)` from `@parcha/agentrun-kernel/process`. An adapter written outside this repository without it keeps the old behaviour: its stopped turn is resumed.
- After `interrupt()`, the Claude Agent and Codex sessions read `open_turn` while the stopped turn is still open in their records. serve's stop settles it there; a runner's pause leaves it for the next process to resume.
- When the earlier process died before it wrote the stopped turn's end, the next one writes it, `interrupted`, before the follow-up's turn starts.
