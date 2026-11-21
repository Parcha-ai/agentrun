---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: fix
---
The CLI capture API uses `agentrun cli-learning enroll|list|revoke|start|get|events|complete`.
Its earlier generated `CLI learning` group was one word internally and did not accept the documented
invocations. The generated TypeScript resource is `cliLearning` with the same verbs, and Python uses
`cli_learning`; API paths and operation IDs are unchanged. The local `learning connect`, `status`,
`disconnect`, `retry` and `hook` commands and the existing learning API commands keep their routes.
