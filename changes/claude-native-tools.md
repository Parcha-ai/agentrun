---
packages: @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: feature
---
The Claude Agent adapter turns the CLI's own tools on by default: `builtins` defaults to `true`, the pinned allowlist (Bash, Read, Edit, Write, NotebookEdit, WebFetch). The tools whose state lives outside the session's log (sub-agents, scheduled jobs, the task list, plan mode, questions) and the provider-hosted ones stay off whatever it says. Pass `builtins: false` for a session whose only tools are the host's.
- The model is offered exactly those built-ins beside the host's tools, and the session proxy forwards their definitions.
- A built-in call is counted in flight before the host hears it start, as a host tool's is, so a pause (`interrupt({ drainMs })`) waits for it. A call that comes while a session pauses is refused as not run.
- Where bubblewrap does not work, a session with built-ins on fails with a named error, as before, unless `unsandboxedCommands: true` says something else is the boundary.
- A call a session skill answers is marked like any other allowed call, so its failure is never reported as the CLI's refusal.
- serve gives its sessions no tools of the harness's own until runs get a confined box, and says so per harness in capabilities (`native_tools: false`).
