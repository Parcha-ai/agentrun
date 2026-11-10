---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A run with no computer that mounts its folder no longer gets a shell on the server. Before, such a run (an agent with no computer on a server without Docker, a browser, a phone or a desktop that does not mount the folder, or a runner place) was given bash in its folder on the server's own machine, where a command could read the server's data and keys. Now, in a server whose run folders are on its own disk, that run gets the file tools alone, confined to its folder: bash and the background tools are not offered, and a bash call answers that it is not available and that a sandbox computer gives a shell. A sandbox, or a desktop whose provider mounts the folder, keeps its shell, and with Archil storage a run with no computer keeps bash on Archil's serverless exec, which runs outside the server. `runShellOf(setting, mode, registry)` says where a run of a computer setting has its shell, before it starts.
