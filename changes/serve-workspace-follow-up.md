---
packages: @parcha/agentrun-serve
kind: feature
---
A request in a workspace (the `AgentRun-Workspace` header) now uploads, lists, reads and deletes files of its own workspace, and its runs take them in `file_ids`; another workspace's file answers `404` as a missing one. A run in a workspace can no longer name another workspace's agent disk in `archil_disk`: it reads as a disk Archil does not have (`422`). An import with no header of a template package name a workspace holds is `409 name_taken`, never replacing that package: delete it first. `features.workspaces` in `GET /v2/capabilities` adds `required_for_tokens`, true when `AGENTRUN_WORKSPACE_TOKENS` names a token that must send the header. A run's workspace is its agent's alone, and the trigger engine's timer runs outside the workspace of the request that armed it. The serve README's Workspaces section lists the known limits.
