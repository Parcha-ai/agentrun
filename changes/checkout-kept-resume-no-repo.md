---
packages: @parcha/agentrun-serve
kind: fix
---
On an Archil region with no serverless exec, a run that parks with a kept sandbox and resumes within its 10 minutes no longer has its `repo/` checkout after the resume. The first claim's release removes the checkout, and the claim that takes the sandbox back makes none, since that sandbox may already have run the agent's code. The run is told this in its system prompt and on its timeline, and always that a `repo/` still there, if there is one, is not its checkout and may be stale (a release that could not remove it). A checkout's fetches now run in a private repository in the machine's own `/tmp`, never in the run's folder, so no `.git/config` there can send them through a proxy or turn TLS checks off; the repository moves into `repo/` after the last fetch.
