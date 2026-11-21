---
packages: repo
kind: ci
---
When the Railway template walk's deploy does not succeed within its 20 minutes, the report now names the status Railway left the deployment in (QUEUED, INITIALIZING, BUILDING or DEPLOYING) with its last build and deploy log lines, or says Railway listed no deployment at all. Before, it said only that the wait ran out.
