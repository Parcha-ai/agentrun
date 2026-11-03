---
packages: repo
kind: ci
---
The merge queue runs the test shards on Node 22.23.2 only; every pull request and every push to `main` still runs them on 22.19.0, 22.23.2 and 24.21.0. A queue run has 10 test jobs in place of 30, and a flaky test on the other two Node versions no longer ejects a change that already passed all three on its pull request. The TypeScript 5.4.5 floor check keeps running in the queue, on 22.23.2. The required checks `verify (22.19.0)` and `verify (22.23.2)` keep their names and run on every event. The risk: a change that breaks only on Node 22.19 or 24 after its pull request ran (a newer base) is caught on `main`'s push run, not in the queue.
