---
packages: @parcha/agentrun, @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
Deploy selected local Claude Code, Codex and Pi setups with `agentrun deploy PROJECT --from RUNTIME --to DESTINATION`.
The CLI previews and uploads project files, instructions, complete authored skill assets and supported configuration,
then moves the same agent into managed execution. `connect --from` stops after upload; `deploy --connected` preserves
an existing connection's identity. Private journals preserve upload bytes and identifiers across retries, and Cloud
workspace checks prevent reusing a connection in a different workspace.

Destinations advertise the versioned source-deployment capability. Pending imports cannot run or be edited until
Move succeeds. Missing model or tool accounts, unsupported source extensions or policies, and incomplete snapshots
remain explicit blockers; source credentials and conversation history are not uploaded. macOS capture requires
Python 3 for descriptor-relative reads; Linux retains its native reader. Pi skill installation is available through
`agentrun skill install --pi`.
