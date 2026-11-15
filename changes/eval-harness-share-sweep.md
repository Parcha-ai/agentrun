---
packages: @parcha/agentrun-serve
kind: fix
---
A local eval whose shared harness install is already in place still goes through the server's own installer for it, under its hold. What an eval killed part way through that install left beside it is now swept by the next eval, as a server sweeps what is left beside its own install.
