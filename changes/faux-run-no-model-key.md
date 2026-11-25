---
packages: @parcha/agentrun-serve
kind: fix
---
A run of a `--faux` start is no longer handed its revision's model's key in its own process. The faux model sends no key, so the run's code held a real provider key it never used; it now holds only the keys its tools run on.
