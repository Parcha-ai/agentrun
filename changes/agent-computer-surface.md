---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's desktop or phone can be driven by code alone or by tools alone, and can have no shell: `definition.computer` takes `surface` ("code" or "tools") and `exec` (false).
- `surface: "code"`: the run gets its harness's script tool (pi's `codemode`, else `computer_script`) and the hand-over, and no `computer_observe`, `computer_act` or `computer_screenshot`. On pi, the `codemode` tool's description declares `computer` then, since no `computer_script` is listed to declare it.
- `surface: "tools"`: the per-step tools and the hand-over, and no `computer_script` and no pi `codemode`. Absent, both, as before.
- `exec: false`: the agent's card has no `exec` or `processes` group, so no tool or script has `computer.shell` or `computer.processes` (a script that reaches for one is refused in words), no folder is mounted in the computer, and the run has no `bash` or background tool anywhere, Archil's exec included. The run's own computer channel (`POST /runs/{run_id}/computer/call`) keeps every group.
- Both are a desktop's or a phone's alone: on another kind, 422 `not_allowed`. GET /agents/{agent_id} shows them.
