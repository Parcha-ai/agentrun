---
packages: @parcha/agentrun-serve
kind: fix
---
A runner that closes while one of its runs has a computer whose daemon died mid-run now hands the run back and lets the computer go inside its close window. The run's end (its background processes ended, its scratch swept) asks that daemon and never got an answer, so the close ran out its whole window with the run still marked as this runner's, no hand-back, the computer's interval still open and the sandbox never released. The end's computer calls are now cut at the point where the close already cuts the run's tool hosts' release: the window less its reserve. A run that ends on its own on a dead daemon is cut at the release's own bound and ends, where before it never did.
