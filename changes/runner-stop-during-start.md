---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve runner` treats a SIGTERM or SIGINT that arrives during its start as its own stop. Before, the runner began claiming runs before its stop handlers were installed, so a signal in that window (a platform's redeploy) ended the process by the signal itself, with its claims still held and any paid request in flight cut. Now the runner listens from before its start, keeps a stop asked during it, says "stopping: a stop came during its start" once the start is done, and closes the way a later stop does (its runs handed back, its store closed, exit 0). The server's own CLI got the same fix in #2410.
