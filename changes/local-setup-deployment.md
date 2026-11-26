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

Incomplete local captures report the affected paths and captured file, skill and tool counts without exposing held
credentials. An in-place Codex model-cache refresh is accepted only when stable reads retain identical content,
file identity and permissions; source policy and account changes still require a fresh capture.
The selected Codex metadata directory may refresh its timestamps only while its identity, size, permissions and exact
entry inventory remain unchanged; selected child files and account policy retain their independent checks.
Codex 0.171.0 and 0.172.0 exports recognize the verified `shell_command` and `unified_exec` model-catalogue labels as
the shell and interactive process capability. Other model-tool differences and unsupported integrations remain blockers.
