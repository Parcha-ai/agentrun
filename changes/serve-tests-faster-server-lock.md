---
packages: @parcha/agentrun-serve
kind: ci
---
The two server-lock tests now spawn a process only where the test is about one. The second server, which must be refused, is still the bin in its own process: it exits 1 with its one line and leaves the data root as it was. The first and third servers run in the test's process. The crash case kills a process that only took the lock, checks that a start is refused while that process lives, then checks that the next start succeeds. Locally, under load, the two tests take about 5 s less.
