---
packages: @parcha/agentrun-serve
kind: fix
---
A run that has ended (failed, completed, cancelled) gives its place back once its process exits, and a start that needs that place now waits for it, up to that process's drain and kill, instead of being refused `429 rate_limited` for a place already being given back. Under load, a failed run's process can outlive the moment the run reads failed; the next start no longer depends on which comes first. A completed run's follow-up waits the same way. Two follow-ups that reach a completed run while it waits for a place share its one reopening, and both are sent to the run; the second is no longer refused with 429 or `unavailable`.
