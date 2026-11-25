---
packages: @parcha/agentrun-serve
kind: fix
---
A run of a `--faux` start is no longer handed a model key: not its revision's model's key in its own process, and not a model gateway's key, whether the gateway is set where the server starts or saved in the console. The faux model sends no key, so the run held a real key it never used; it now holds only the keys its tools run on.
