---
packages: @parcha/agentrun-serve
kind: fix
---
A person's take-over of a run's desktop or phone now survives a change of runner. Until now, when the runner holding the run lost its claim during a take (it crashed, or stalled past its lease), the runner that took the run over brought the computer up with the agent driving: the person's take was dropped, and a run whose agent had already answered ended under their hand instead of waiting for their hand-back. The new claim now reads the take from the run's journal and keeps the person driving, so the run still waits for the hand-back and the agent's next call stays parked until then.
