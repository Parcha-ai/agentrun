---
packages: @parcha/agentrun-serve
kind: fix
---
pi's code-mode scripts record their computer calls: each computer protocol call a `codemode` script makes is in the `computer_calls` of that call's `tool_result` row on the Timeline, as `computer_script`'s and the per-step tools' are (same record, same bound and `computer_calls_dropped`). Before, a pi run that drove its desktop or phone through code mode showed none.
- Every pi-native tool's call records the computer calls it makes on its own row (a subagent's own hosted calls stay on theirs).
- A script replayed after a restart is handed back the results of the calls it made before and makes them only once, so none is recorded twice. Its row holds the calls the rerun made; the cut attempt's record goes with it, as a host tool's cut attempt's does.
