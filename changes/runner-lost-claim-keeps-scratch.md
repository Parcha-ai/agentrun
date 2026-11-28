---
packages: @parcha/agentrun-serve
kind: fix
---
A runner that loses a run's claim no longer deletes the scratch of the runner that took the run over. Every claim of a run opens the same folder and writes its TMPDIR and bash's full outputs at the same paths (`.agentrun/tmp`, `.agentrun/output`), so the old claim's end, or its project capture's settle, could sweep them while the new claim was still using them. Both now sweep only when the runner still holds the claim, asked after the run's background processes have ended. A shutdown whose claim is still renewed sweeps as before. A claim that is lost or unknown leaves the scratch: a later claim's end sweeps it, and deleting the run removes it.
