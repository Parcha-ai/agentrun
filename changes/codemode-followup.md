---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
A `codemode` script's calls read as part of that script on the run's timeline, and a script can test for a tool with `typeof`.
- Each call a script or `tools_call` made now names the outer call in `parent_tool_use_id`, on its `tool_use` and `tool_result` rows. Before, only its `<callId>/s<n>` id tied it to the script.
- In the default timeline view, a `computer_observe` or `computer_act` row previews the app it names, top-level or nested. What an act types is still never shown there, and neither is a script, which can hold it.
- A learned workflow or a skill read that a script or `tools_call` made still counts as the model's own call in a run's learning path and cost.
- `typeof tools.missing` in a `codemode` script now gives `"undefined"` for a tool the run doesn't have. Before, it threw. Calling an unknown tool, or reading one any other way, still throws the error that lists the run's tools.
- On a computer with no `ui` group, a `computer_act` that names an app still brings it to the front first (one `apps.launch`, then the input). Raw input goes to the focused window, and the focus can change without the run seeing it. An act that names no app makes the one input call.
