---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: fix
---
A harness's own process dies with the process that started it. The Claude Agent CLI runs detached, in its own process group, and does not exit when its stdin closes, so a host that was SIGKILLed (and ran no close) left its CLI running, reparented, one more per crash. `@parcha/agentrun-kernel/host` now has `parentWatched(child)`: on Linux with util-linux setpriv the child starts under `setpriv --pdeathsig KILL --` (the kernel kills it the moment its parent dies), elsewhere under a small node shim that kills it when it is reparented. The Claude Agent machine launches every child with it, inside the host's confinement (`launchCommand`: the confine prefix, then the watch, then the pinned binary), so the death signal is set after any switch of user the prefix makes. The watch adds nothing to the child's environment.
