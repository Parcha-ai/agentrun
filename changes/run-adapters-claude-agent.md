---
packages: @parcha/agentrun-claude-agent
kind: feature
---
New package `@parcha/agentrun-claude-agent`, held (not on npm yet): the Claude Agent SDK as an AgentRun harness, adapter id `claude-agent`. `claudeAgentAdapter(options)` is an `AgentAdapter`, so `createHarnessRunner(claudeAgentAdapter(...), { store, tools })` runs a DSL `agent` node on the Claude Agent CLI.
- The host brings the SDK, an exact optional peer (0.3.286, whose CLI is 2.1.286); the adapter checks the SDK and its CLI against the pins when it is made, and throws `ClaudeAgentPinMismatch` or `ClaudeAgentNotInstalled` ("Claude Agent SDK not installed"). A host may pass the SDK module and the CLI's path (`sdk`, `sdkVersion`, `cliPath`).
- The CLI's built-in tools are off: the host's tools are its only tools, each call recorded before it runs, and a `PreToolUse` hook denies every other call and every error path. A test runs the pinned CLI against a scripted model that tries its built-ins, the web, sub-agents, scheduled jobs and another MCP server: nothing runs, writes or fetches.
- The CLI's model traffic goes through the session's loopback proxy (`@parcha/agentrun-adapters/host`) with an Anthropic policy: the pinned CLI's routes only, the session's model, no provider-hosted tool or anything the provider would fetch, the session's tools only, a known `anthropic-beta` set, and the runner asked before every paid request. A refusal names no request content.
- The CLI runs in the session's own directories with an empty working directory and an allowlisted environment; no provider key, sign-in or operator settings reach it.
