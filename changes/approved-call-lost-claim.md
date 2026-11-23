---
packages: @parcha/agentrun-serve
kind: docs
---
The approvals route's description now says what an allowed call does when the runner loses its claim while the call runs. An allowed call runs once. If the claim lapses before the call's end is recorded, a read may run again on the run's next claim. A call with a side effect never runs again: the next claim answers it as interrupted, and the model is told so. A new test pins both cases on pi and checks that the lapse is recorded in the run's attempts.
