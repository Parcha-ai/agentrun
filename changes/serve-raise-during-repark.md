---
packages: @parcha/agentrun-serve
kind: fix
---
A raise that reaches an agentic run's claim while that claim is parking the run again at its cap (a refused raise woke it, and the park is slow, as one that keeps a computer is) now waits for the run's next claim, which resumes the run. Before, the parking claim took the raise and the run was left parked with nothing to wake it.
