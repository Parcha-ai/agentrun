---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a computer is told its folder by its absolute name (`/workspace`) in the first line of its system prompt, and to save what it keeps there rather than in its home directory. A computer's shell has its own home (`/work` on the hosted images), so an agent told only "your working directory" could write its result to `~` and the run's files would not hold it. A run with a local folder is not told a path: its shell's home is the folder.
