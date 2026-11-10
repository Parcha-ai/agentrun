---
packages: @parcha/agentrun-serve
kind: fix
---
An approval answered while its run is parking, ending or being stopped no longer fails with "Session is closed". The runner used to check the answer through a session the run had already closed. Now the answer is left for the run's next claim, which checks it and resumes the run. An answer replayed at a claim's start that fails is logged and left untaken instead of crashing the runner with an unhandled rejection. The tool-gate test no longer waits a real minute: it checks that the parked run's claim was let go.
- Upgrading: nothing to change.
