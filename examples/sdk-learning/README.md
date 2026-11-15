# Learning in an existing backend SDK agent

These opt-in live examples wrap an existing Claude Agent SDK query or Codex SDK client. Your backend still starts the job and runs its tools. AgentRun stores its result, checks proposed learning, and supplies approved notes and skills to the next fresh SDK session.

Use the client and server from this reviewed development checkout. These wrapper entry points are not a claim about an already-published npm release.

From the repository root, after installing and building the checkout:

```sh
npm run build -w @parcha/agentrun-client
npm install --prefix examples/sdk-learning --ignore-scripts --package-lock=false
```

Run the matching AgentRun server with its runner enabled. Set up an API key and a reflection/grading model under Settings. Set `AGENTRUN_BASE_URL` to its API URL ending in `/v2`, and `AGENTRUN_API_KEY` in your backend environment. Keep your existing Claude/Codex credentials in that backend. Do not paste either kind of key into a prompt.

Choose one example:

```sh
npm run claude --prefix examples/sdk-learning -- --live
npm run codex --prefix examples/sdk-learning -- --live
```

Both commands make real model calls and create two demo agents on your server. `CLAUDE_MODEL` or `CODEX_MODEL` can select the existing backend model. AgentRun's reflection and independent grading use the separately configured server model and add usage.

Each example performs three tasks with fictional release data:

1. Teach a reporting preference while using the backend's existing read-only tool.
2. Wait for checking/grading to accept a note or skill, then make the same request in a fresh session without repeating the preference.
3. Make that request with a separate learning-Off control agent.

The script checks the accepted note or skill, the learning revision supplied to the second run, the reused prefix, the control answer, and native tool execution. It prints those results and links to the runs. A failed check exits nonzero; it does not retry a paid task or force a proposal through review. Inspect the agent's Learning Dojo results and run timeline to understand a rejection. This is one integration smoke test, not a learning-quality benchmark.

Claude uses a real in-process MCP `release_status` tool. Codex uses its normal shell in a temporary read-only workspace containing `release-status.json`; that workspace is removed afterward. Agent definitions and run evidence remain in AgentRun so you can inspect them.

On Linux, the default Codex shell example needs the namespaces required by Codex's read-only sandbox. Some restricted containers or VMs disallow them. If a tool fails with a namespace or `bwrap` permission error, use the read-only MCP variant:

```sh
npm run codex --prefix examples/sdk-learning -- --live --mcp
```

This configures a real stdio `release_status` service in the backend's native Codex `mcp_servers` settings. The service returns only the fixed fictional status and performs no filesystem or network operations. Codex keeps its read-only sandbox. The smoke test requires a completed tool call and the observed service/version/status/test facts; a failed shell invocation is not counted as successful tool use. A container must still have capacity to start the SDK and MCP processes.

To adapt an existing backend, see the [Claude Agent SDK cookbook](../../docs/tutorials/claude-sdk-learning.md) or [Codex SDK cookbook](../../docs/tutorials/codex-sdk-learning.md). The example factories are also exported, so a test harness can pass an already-configured SDK client/query without replacing its credentials or provider configuration.
