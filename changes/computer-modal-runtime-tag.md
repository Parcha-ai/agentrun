---
packages: @parcha/agentrun-computer
kind: breaking
---
Modal: `attach` refuses a computer made by an earlier version, because its `agentrun.computer.spec` tag records no runtime. Release it with `release(ref, "delete")` and make it again.
