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

## Learn an executable workflow

The workflow variants add an explicit MCP bridge to each native SDK. Your existing backend tools and the learned workflow call the same callback functions. See the [workflow MCP cookbook](../../docs/tutorials/sdk-workflow-learning.md) to adapt your own backend.

Build the DSL and client before installing the standalone example dependencies:

```sh
npm run build -w @parcha/agentrun-dsl
npm run build -w @parcha/agentrun-client
npm install --prefix examples/sdk-learning --ignore-scripts --package-lock=false
npm run claude:workflows --prefix examples/sdk-learning -- --live
# Or test the other native SDK:
npm run codex:workflows --prefix examples/sdk-learning -- --live
```

Use the same server, API key, server grading model and backend credentials described above. Each command can make seven native-model tasks plus the associated server reflection/grading calls. It creates an On agent and an Off control. These examples use local read-only tools with no metered tool cost; the model calls still incur usage. They do not require native shell execution.

The sequence is:

1. Teach a reusable two-tool procedure: read a fictional release's status, then pass that unchanged status to the existing formatter.
2. Require an accepted run-generated skill. Make up to four fresh practice runs so the ordinary policy sees that skill in three earlier runs before proposing a workflow.
3. Require an active workflow generated and checked by the normal learning pipeline. A pending proposal stops the demo for owner review; the script never approves it.
4. Request a different service in a fresh native session. Require the accepted workflow revision, a successful `learned_workflow` MCP invocation, and both original tool callbacks executing inside that workflow with the new service/version.
5. Give a learning-Off agent the same request. Verify its tools still work and no learned workflow was offered or executed.

The formatter accepts only the exact fresh status object returned by the status callback, including a new observation identifier. A hardcoded answer, stale result, or direct-tool fallback cannot satisfy the workflow-reuse assertion. The evidence output includes the generated workflow, learning revision, console links, lifecycle events, and fictional tool observations. It deliberately excludes native prompts, run tokens and MCP capability values.

The native SDK configuration has two MCP servers: the existing release tools and the learning bridge. The bridge is configured once, while each fresh run receives its own capability. Both demo callbacks declare `readOnly: true`, so the bridge can truthfully advertise read-only behavior to the native MCP approval policy. Claude uses its normal HTTP MCP options. Codex uses native `mcp_servers` constructor configuration and keeps its read-only sandbox. The wrapper never mutates a constructed Codex client's private options.

The exported factories are `createClaudeWorkflowReleaseBackend(sdk, learning, existingOptions)` and `createCodexWorkflowReleaseBackend(createExistingCodex, learning, existingThreadOptions)`. For Codex, the construction callback receives the two demo MCP entries so your backend can merge them with its own configuration and retain its credentials. Both factories expose `report`, `flushLearning`, and `close`. The demo's tool policy allows only these fictional read-only callbacks; use your real tool policy in an application.

Run the offline fixture, MCP transport and proof checks without making model calls:

```sh
node --test examples/sdk-workflow-learning.test.mjs
```
