---
packages: @parcha/agentrun-serve
kind: fix
---
Runs left by a server that stopped are taken up correctly by the next start. Two cases were wrong. A run of a harness this host's memory can never hold (say a claude-agent run left working, restarted on a 384 MB host) used to be claimed anyway and read working forever. Now its claim fails it, in the same words a new start of it is refused with ("This server has 384 MB of memory … so it can't start here."). A stop or cancel sent just before the server stopped used to be left for the next start, whose runner could resume the run's turn before applying it. Now the closing runner applies it: the run ends stopped or cancelled before the stop is done, and the next start never opens it again.
- Upgrading: nothing to change.
