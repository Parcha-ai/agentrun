---
packages: @parcha/agentrun-serve
kind: fix
---
A claude-agent or codex run installs its harness on first use again. When nothing was installing Claude Code or Codex (none started yet, an install cut short or failed earlier, or a server that stopped part way), the run failed saying it was not installed; now the run installs it and runs on it, one install at a time on the data, which every run that needs it waits for. The run's timeline says "Installing Claude Code (first use)…" (or Codex) while it waits, not only once it is done.
A CLI run's harness is given its tools in the order the agent grants them.
