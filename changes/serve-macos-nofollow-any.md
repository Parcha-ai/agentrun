---
packages: @parcha/agentrun-serve
kind: fix
---
On macOS a local run's file calls work again: each open in the run's folder passes O_NOFOLLOW_ANY alone, since the kernel refuses it beside O_NOFOLLOW (EINVAL), which failed the first folder open of every call.
