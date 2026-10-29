---
packages: @parcha/agentrun-adapters, @parcha/agentrun-claude-agent, @parcha/agentrun-codex
kind: fix
---
A harness's CLI started on Linux with `parentWatched` no longer outlives a host that dies while it starts. A parent-death signal set after the parent is gone never fires, so a host killed between the spawn and setpriv's `--pdeathsig` left the child unwatched. The watched command now checks, after the signal is set, that its parent is still the host, and runs nothing otherwise (exit 1).
