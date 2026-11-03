---
packages: repo
kind: fix
---
`npx @parcha/agentrun` stops its server when the npm that runs it ends: a SIGTERM or SIGKILL to npm alone (a process manager's) used to leave the server running with nobody to stop it. Only a command that npm exec started watches its npm; started any other way (an installed `agentrun`, in the background of a shell that then exits, under nohup), it keeps running as before. A SIGINT to npm alone still reaches nothing, since npm leaves SIGINT to the terminal's process group: stop it with Ctrl-C in its terminal, a signal to its process group, or a SIGTERM to npm. With no server installed beside it, `npm exec` only fetches the server's latest release and names its bin, and the command runs that server as its own child, so a stop reaches the server, which drains each run once. `@parcha/agentrun` is 0.3.1.
