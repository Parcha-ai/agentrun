---
packages: @parcha/agentrun-serve
kind: fix
---
A raise the cap's rule refuses (a race of two raises, or a retry after the run parked again) no longer writes a second `agentrun.budget` entry when it wakes an agentic run parked at its cap. The run parks again on the pause it stood at, with nothing written: one "Paused at the run's cap" row on its timeline, the row in the pause's words, and a later raise resumes that pause.
