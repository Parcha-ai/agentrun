---
packages: @parcha/agentrun-learn, @parcha/agentrun-serve
kind: feature
---
`@parcha/agentrun-learn` is published to npm from this release, with AgentRun Server, which uses it at runtime: the learning folder's note format, the checker of what a run proposes, the end-of-run prompt, and the grader's prompt and verdict. The server depends on it at the workspace version, and a stranger install of the server gets it beside the other packages it uses.
