---
packages: @parcha/agentrun-harness-claude
kind: feature
---
New package `@parcha/agentrun-harness-claude`, held (not on npm yet): the Claude Agent SDK as an AgentRun harness, adapter id `claude-agent`. `claudeAgentAdapter(options)` is an `AgentAdapter`, so `createHarnessRunner(claudeAgentAdapter(...), { store, tools })` runs a DSL `agent` node on the Claude Agent CLI.
- The host brings the SDK, an exact optional peer (0.3.286, whose CLI is 2.1.286); the adapter checks the SDK and its CLI against the pins when it is made, and throws `ClaudeAgentPinMismatch` or `ClaudeAgentNotInstalled` ("Claude Agent SDK not installed"). A host may pass the SDK module and the CLI's path (`sdk`, `sdkVersion`, `cliPath`).
- The CLI's built-in tools are off: the host's tools are its only tools, each call recorded before it runs, and a `PreToolUse` hook denies every other call and every error path. A test runs the pinned CLI against a scripted model that tries its built-ins, the web, sub-agents, scheduled jobs and another MCP server: nothing runs, writes or fetches.
- The CLI's model traffic goes through the session's loopback proxy (`@parcha/agentrun-kernel/host`) with an Anthropic policy: the pinned CLI's routes only, the session's model, no provider-hosted tool or anything the provider would fetch, the session's tools only, a known `anthropic-beta` set, and the runner asked before every paid request. A refusal names no request content.
- The CLI runs in the session's own directories with an empty working directory and an allowlisted environment; no provider key, sign-in or operator settings reach it.
- A host can start the CLI under its own confinement with `confine` (a `setpriv --no-new-privs` prefix, say): it may only add in front of the pinned binary and its arguments, and never touches the environment; anything else is refused when the CLI starts. Every child of a session gets `GIT_CEILING_DIRECTORIES` set to the session's directory, so the CLI's own git never looks for a repository above it.
- A request on the session's small model is asked about and priced as the small model (the Anthropic policy names the model of the body it checked).
- Every drive of a session writes through one serialized writer, so a drive opened after an interrupt reads only once the halted drive's last writes are in: a `never` tool that finished as the interrupt landed is folded completed, never taken for abandoned. An interrupt waits for a host tool's call in flight rather than abandon it, so a host tool must honour its signal or carry its own deadline.
- The pinned CLI is looked up beside the adapter's own install, not from the process's working directory.
- A missing `zod` beside the adapter is refused when the adapter is made (`ClaudeAgentNotInstalled`), not at the first turn.
