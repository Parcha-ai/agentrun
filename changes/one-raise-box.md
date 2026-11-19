---
packages: @parcha/agentrun-serve
kind: fix
---
A run paused at its spend cap shows one raise form in the console. The header's Raise the cap button now takes you to
the form under the pause banner, where it was opening a second form above it. A working run's header still opens its own,
as does a paused run's on the Graph and Dev tools tabs, which show no banner.
