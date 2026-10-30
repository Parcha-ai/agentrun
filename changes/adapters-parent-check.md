---
packages: @parcha/agentrun-adapters, @parcha/agentrun-claude-agent, @parcha/agentrun-codex
kind: fix
---
A harness's CLI started on Linux with `parentWatched` no longer outlives a host that dies while it starts. A parent-death signal set after the parent is gone never fires, so a host killed between the spawn and setpriv's `--pdeathsig` left the child unwatched. The watched command now checks, after the signal is set, that its parent is still the host. Otherwise it runs nothing, exits 125, and says why on stderr (`agentrun: parent check failed: started by <pid>, expected <host>`). The check runs in Node and execs the command in place, so the command's pid and environment are unchanged; it needs `process.execve` (Node 22.15 or newer), and without it fails the same way, saying so.
