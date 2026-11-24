---
packages: @parcha/agentrun
kind: fix
---
The installer asks before it makes AgentRun a service of the user (GRE-4837). In a terminal (`curl … | sh` included) it asks "Keep AgentRun running as a service of this user (it starts again at login)? [y/N]"; No, the default, starts AgentRun in the background until the machine stops, and says how to install the service later. With no terminal to ask in (CI, a script) it installs the service as before; `--no-service` says no there, and `--service` installs it without asking.
