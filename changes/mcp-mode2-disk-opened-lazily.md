---
packages: @parcha/agentrun-serve
kind: fix
---
On a Mode 2 run's own process, the runner's MCP no longer opens a second Workspace on the run's Archil disk at every claim. The open listed the run's folder and swept its spill folder. It now opens at the first answer that files something there (a long answer, a fal result), once per claim, and lets it go at the claim's release, including an open still running then. A filing after the release opens nothing and files nothing. A claim whose MCP files nothing opens none. The gateway's `work` may now return a Promise, which it awaits before filing. A Workspace that can't be opened files nothing, as a failed write does: the long answer says it could not be saved, and a result is left out.
