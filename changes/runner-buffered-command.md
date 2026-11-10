---
packages: @parcha/agentrun-serve
kind: fix
---
A runner no longer crashes when an approval's answer, a message or a steer arrives just as a run's claim ends before its session is ready. The answer waits for the run's next claim instead of being lost, and the runner process logs any promise rejection nothing handled and keeps serving its other runs.
