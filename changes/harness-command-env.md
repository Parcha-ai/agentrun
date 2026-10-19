---
packages: @parcha/agentrun-harness
kind: fix
---
A command the agent runs gets only `PATH`, `HOME`, `TMPDIR` and `LANG` from the host. The agent's `bash` tool and code mode's `tools.bash` run with `inheritEnv: false`, so a provider key the host holds for its own model calls (a live run's declared keys) never reaches a command, and a prompt that makes the agent run `printenv` reads none. A command that needs a key goes through a host tool.
