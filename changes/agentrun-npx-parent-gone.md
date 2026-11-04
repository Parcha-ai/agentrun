---
packages: @parcha/agentrun
kind: fix
---
`npx @parcha/agentrun` stops its server when the npm that runs it ends: a SIGTERM or SIGKILL to npm alone (a process manager's) used to leave the command and the server running with nobody to stop them. An npm gone before the server starts (during a first run's download) means no server starts. Only a command that npm exec started watches its npm; started any other way (an installed `agentrun`, in the background of a shell that then exits, under nohup), it keeps running as before. A SIGINT to npm alone still reaches nothing, since npm leaves SIGINT to the terminal's process group: stop it with Ctrl-C in its terminal, a signal to its process group, or a SIGTERM to npm. A SIGHUP to the command alone now stops the server as a SIGTERM does, and the server drains each run once. `@parcha/agentrun` is 0.3.2.
