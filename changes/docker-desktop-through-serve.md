---
packages: @parcha/agentrun-computer
kind: fix
---
A Docker desktop started by a server run is a desktop: Docker's descriptor builds its desktop configuration with `desktop: {}`, so the server's provider starts the X server, and the run's computer has `screen`, `input.pointer`, `input.keys` and `apps`. Before, the run got a Linux computer with exec, files and processes alone, and a codemode script had no `computer.screen` or `computer.apps`.
