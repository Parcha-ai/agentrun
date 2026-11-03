---
packages: repo
kind: ci
---
**Each pi leg runs as five jobs, so a merge queue run takes about 8 minutes less**
- `verify (<node>)` waits on every pi leg, and the leg that ran the agentrun-serve, pi-transport and pi-git-remote suites one after another took about 21 minutes: the longest job in the queue.
- Each leg now runs as `pi-1-2 (<pi>, consumer)`: the packed packages installed in an empty directory, and the reference example; `first`: agentrun-serve, and the mid-stream kill and resume; `transport`: pi-transport and pi-git-remote; `browser`: pi-browser, pi-durable-disk and pi-durable-agent; `rest`: every other pi workspace, and any new one. Each suite still runs once on each pi version.
- Estimated from the last queue runs: the longest leg drops to about 13 minutes, and a queue run from about 22 to about 14 minutes. The cost is six more jobs per run on standard runners, about 27 more runner-minutes, since each repeats the install and the build, and six more installs from the npm registry.
- Risk: the same suites run on the same runners with the same installs; only the grouping changes. The required checks, `verify (22.19.0)` and `verify (22.23.2)`, keep their names.
