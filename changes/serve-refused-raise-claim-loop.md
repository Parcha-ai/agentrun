---
packages: @parcha/agentrun-serve
kind: fix
---
A capped workflow run parked at its cap that a claim wakes with no raise that resumes it (a raise the cap's rule refuses, from a race of two raises or a retry) now parks again on the pause it stood at, with nothing written, before any step runs. Before, each such claim ran the held step into the same cap and wrote a new `agentrun.budget` entry. A refused raise's row is left untaken and wakes the run on every poll, so the entries grew without bound.
