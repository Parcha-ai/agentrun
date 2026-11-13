# Learn workflows without replacing your backend SDK

The [Claude Agent SDK](claude-sdk-learning.md) and [Codex SDK](codex-sdk-learning.md) wrappers can supply more than notes and skills. With an explicit MCP bridge, an accepted workflow can call your backend's existing tool callbacks on a later request. Your application still starts the job, owns its native SDK client, and supplies its tool permissions and credentials.

This requires the client and server from the same reviewed development checkout. Build the DSL and client packages, and install their checkout versions alongside `@modelcontextprotocol/sdk` in your backend. The workflow entry point uses the DSL interpreter and MCP SDK; the notes-and-skills wrappers do not require a bridge.

## Register existing callbacks once

Expose the tools a learned workflow may call, using their canonical MCP names and actual schemas. Pass the same callback functions used by your existing tools. The following example assumes `readReleaseStatus`, `statusInputSchema`, `statusOutputSchema`, and `authorizeTool` already belong to your backend:

```ts
import { createWorkflowMcpBridge } from '@parcha/agentrun-client/workflows';

const workflows = await createWorkflowMcpBridge({
  tools: [{
    name: 'mcp:release/release_status',
    description: 'Read the current release status for a service.',
    input_schema: statusInputSchema,
    output_schema: statusOutputSchema,
    permission: 'allow', // Declare your actual existing tool policy.
    readOnly: true, // Only if this callback cannot change external state.
    // Set price_usd: 0 only if this callback truly has no metered cost.
    execute: readReleaseStatus,
  }],
  policy: authorizeTool, // Return 'allow', 'ask', or 'deny' for this invocation.
  maxToolCalls: 32,
  maxDurationMs: 60_000,
});
```

`execute(args, context)` receives `signal`, `runId`, `workflow`, and `idempotencyKey`. Honor cancellation and keep the callback's existing authorization and side-effect protections. A permission requiring confirmation must not silently become `allow`; this bridge does not supply an approval dialog. Unknown tool pricing can leave a proposed workflow pending owner review. Do not declare a metered API free just to get it accepted.

The optional `readOnly` declaration informs the native MCP approval policy. The bridge advertises a read-only workflow tool only when every allowed callback explicitly declares `readOnly: true` and no model or judge adapter is configured. Otherwise the bridge remains a potentially state-changing tool. This annotation does not replace the live `policy` check, and should never be used to bypass native approval for a tool that can write.

The bridge starts a loopback HTTP MCP endpoint. Its `url` and `headers` configure the native SDK; the wrapper binds each run to that bridge with an expiring capability. One bridge can serve multiple fresh runs. Keep it alive for the backend's lifetime and call `await workflows.close()` during shutdown. Keep the bearer headers and injected capabilities out of logs.

## Claude Agent SDK

Add the bridge to your normal MCP options, and pass the same bridge to the wrapper. Preserve your other servers, tools, hooks, model and permission settings:

```ts
import { query as nativeQuery } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeAgentLearning } from '@parcha/agentrun-client/claude';

const query = withClaudeAgentLearning(nativeQuery, {
  agentId: 'release-backend',
  baseUrl: process.env.AGENTRUN_BASE_URL,
  apiKey: process.env.AGENTRUN_API_KEY,
  instructions: existingStandingInstructions,
  learning: true,
  workflows,
});

const options = {
  ...existingOptions,
  mcpServers: {
    ...existingOptions.mcpServers,
    agentrun_workflows: {
      type: 'http' as const,
      url: workflows.url,
      headers: workflows.headers,
    },
  },
  // Add this only where your existing permission policy permits the bridge.
  allowedTools: [
    ...(existingOptions.allowedTools ?? []),
    'mcp__agentrun_workflows__learned_workflow',
  ],
};

for await (const event of query({ prompt, options })) {
  deliverOriginalEvent(event);
}
await query.flushLearning();
```

Choose an unused MCP server name if `agentrun_workflows` already exists. The wrapper does not replace your native tools or open another turn to execute a workflow. The native agent calls the bridge's `learned_workflow` tool, and the workflow interpreter invokes only the callbacks you registered.

## Codex SDK

Codex configures MCP servers at client construction. Add the bridge there, alongside your existing constructor configuration, then wrap that exact client instance:

```ts
import { Codex } from '@openai/codex-sdk';
import { withCodexAgentLearning } from '@parcha/agentrun-client/codex';

const existingCodex = new Codex({
  ...existingCodexOptions,
  config: {
    ...existingCodexOptions.config,
    mcp_servers: {
      ...existingMcpServers,
      agentrun_workflows: {
        url: workflows.url,
        http_headers: workflows.headers,
      },
    },
  },
});
const codex = withCodexAgentLearning(existingCodex, {
  agentId: 'release-backend',
  baseUrl: process.env.AGENTRUN_BASE_URL,
  apiKey: process.env.AGENTRUN_API_KEY,
  instructions: existingStandingInstructions,
  learning: true,
  workflows,
});

const result = await codex.startThread(existingThreadOptions).run(prompt);
await codex.flushLearning();
```

Here `existingCodexOptions`, `existingMcpServers`, and `existingThreadOptions` are your backend's current settings. Keep its provider, credentials, working directory, sandbox and approval policy. The wrapper does not inspect or mutate a constructed client's private configuration. Existing callbacks also remain available through your original native tool configuration; the workflow bridge is an additional MCP server.

## What can become a workflow

Ordinary checked learning first accepts reusable skills. After a skill has appeared in enough earlier runs, reflection may propose an executable workflow. The server checks the proposal against the registered tool capabilities, permissions and cost information and independently grades it. Pending proposals stay pending until their owner reviews them. A later fresh run receives only the accepted workflow revision.

The initial bridge supports workflows over the explicitly registered callbacks. It supplies no default shell, arbitrary code executor, or model provider. Workflows needing agent or judge nodes require explicit backend `runNode` or `runJudge` adapters. Reflection cannot assume those adapters exist when you have not supplied them. Your backend remains responsible for the adapter's model credentials, policies and cost.

When self-improving is Off, a fresh run receives no learned workflows. The bridge also revokes that run's capability when the native session finishes; it is not a permanent workflow endpoint for that agent. Notes/skills and workflow learning remain scoped to the stable AgentRun id and the accepted learning revision.

## Prove learning and reuse

The [workflow release-reporter examples](../../examples/sdk-learning/README.md#learn-an-executable-workflow) run the full sequence for either native SDK. They use two real, local, read-only MCP tools: fetch a fictional release status, then format exactly that observed status. Both native calls and the learned workflow use the same callback objects.

The test teaches the sequence, waits through the ordinary repeated-skill cadence, and requires an active workflow generated by a real run. It then changes the requested service and version in a fresh session. Success requires the accepted revision, a completed MCP workflow invocation, both original callbacks running inside that workflow, and an answer matching their fresh result. A correct-looking answer produced by direct tool fallback fails that proof. A separate learning-Off agent receives the same fresh request for comparison.

The examples make paid native-model and server reflection/grading calls only with `--live`. They never write a workflow file themselves, bypass owner review, lower the promotion threshold, or blindly repeat a failed paid call. Inspect the generated workflow and run evidence in Learning Dojo. This is an integration smoke test, not a claim that every repeated task should or will become a workflow.
