---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-codex
kind: fix
---
Three fixes to codemode's computer calls. A script call a person allowed carries its computer calls on its own result row only, not on its approval and "ran once you allowed it" rows too, so summing a run's rows counts each computer call once. A script rerun after a crash tells a recorded call whose answer has no value (a file write) by its answer's words, as it was answered live, not as `completed: null`. On Codex, a code-mode `exec` has its own rows, and each host tool call its script makes sits under it (`parent_tool_use_id`, the exec's call id), as a codemode script's calls do on pi, claude-agent and opencode; a host lends this through the new optional `SessionIO.ownCalls`. A Codex script that failed reads failed on its exec's row, never `exec: ok`.
