---
packages: @parcha/agentrun-computer
kind: fix
---
A hosted computer refuses a caller's label named `agentrun` or `agentrun-<n>` (`agentrun-0`, `agentrun-1` and on), in words, at check() and at create. Those names hold a computer's packed labels, and a label under one, stored as given, could read back as a packed map.

Modal's packed tags are one-way across an upgrade. A server from before the change finds a request's sandbox by its labels as given alone, so its retry of a create can make a second sandbox beside a newer server's packed one. That sandbox lasts until a newer server's create of the same request keeps the older of the two, or until Modal ends it at its lifetime. Upgrade every server that shares a Modal app together to avoid it.
