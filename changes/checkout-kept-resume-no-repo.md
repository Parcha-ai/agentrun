---
packages: @parcha/agentrun-serve
kind: fix
---
On an Archil region with no serverless exec, a run that parks with a kept sandbox and resumes within its 10 minutes no longer has its `repo/` checkout after the resume. The first claim's release removes the checkout, and the claim that takes the sandbox back makes none, since that sandbox may already have run the agent's code. The run is told this in its system prompt and on its timeline. If that release could not remove the checkout and a `repo/` is still there, the run is told that folder is not this claim's checkout and may be stale. A checkout's fetches now always verify TLS and go through no proxy, whatever the checkout's own `.git/config` says.
