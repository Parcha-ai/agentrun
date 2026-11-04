---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
A Claude or Codex turn the person stopped stays stopped when the run's process is replaced. Before, the next process found the stopped turn still open in the session and resumed it: it ran its tools and paid for its model requests again, and its answer came before the person's follow-up. Now serve's open reads the run's stop record and settles that turn, ended `interrupted`, with nothing sent, and the follow-up is a turn of its own. A turn a crash or a drain cut is resumed as before.
- `AdapterSession` has `settleOpenTurn()`: it records the open turn as ended, interrupted, and sends nothing. The Claude Agent, Codex and faux adapters implement it; an adapter written outside this repository adds it.
- When the earlier process died before it wrote the stopped turn's end, the next one writes it, `interrupted`, before the follow-up's turn starts.
