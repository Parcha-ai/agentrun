# Learn workflows without replacing your backend SDK

The [Claude Agent SDK](claude-sdk-learning.md) and [Codex SDK](codex-sdk-learning.md) wrappers can supply more than the owner's corrections. With an explicit MCP bridge, a promoted workflow can call your backend's existing tool callbacks on a later request. Your application still starts the job, owns its native SDK client, and supplies its tool permissions and credentials.

This requires the client and server from the same reviewed development checkout. Build the DSL and client packages, and install their checkout versions in your backend. Also install the workflow entry point's optional peers explicitly:

```sh
npm install @modelcontextprotocol/sdk@1.32.2 ajv@8.18.0 ajv-formats@3.0.1
```

Your backend imports the DSL interpreter and supplies its inspection, execution and schema-resolution functions through the bridge's required `engine` option. The client stays an API surface and imports no workflow engine. The MCP entry point uses the MCP SDK; the basic wrappers do not require a bridge.

## How MCP fits in

Think of a learned workflow as a saved recipe that can use your agent's existing tools. MCP gives the native agent one extra tool, `learned_workflow`, to follow a promoted recipe:

1. Your backend starts a normal Claude or Codex task. The wrapper records the run through the AgentRun API.
2. Once the agent has its `learning.compile_after` completed runs, the server compiles a draft and validates its structure and synthesized dry run. This does not promote it.
3. On a fresh task, the server reserves one draft as `learning.check`, separate from executable workflows. The agent answers normally with its original tools; it receives no workflow on this check turn. Afterward the shared client runs the draft in process against that turn's recorded tool evidence, without repeating tool writes. The server compares the draft's answer with the agent's own answer and records promotion or a hold.
4. A later task receives only promoted workflows. The native agent can choose its `learned_workflow` MCP tool when one fits the request and standing instructions. The bridge executes it with fresh inputs and the original registered callbacks, checking the live tool policy.

For example, a release reporter can learn “read the release status, then format the brief.” After an independent check passes, a later request can follow that sequence for the newly requested service. Your application still starts the job, and your backend still executes its tools. The AgentRun API handles evidence and learning delivery; MCP handles the agent's call to the workflow bridge.

## Which keys do I need?

| Component | Authentication |
| --- | --- |
| Existing Claude or Codex agent | Keep its current native login or provider credentials in your backend. |
| AgentRun wrapper | An AgentRun API key (`AGENTRUN_API_KEY`) for recording runs and fetching accepted learning. |
| Server compile turn | A working model route configured on the AgentRun server, with that provider's credentials, such as an OpenRouter key. Compilation model calls incur usage separately from the native task. The initial SDK shadow comparison does not call another model. |
| Original tool callbacks | Keep any credentials those tools already need in your backend. |
| Optional workflow model or judgment nodes | Supply an explicit `runNode` or `runJudge` adapter and its provider credentials. The bridge supplies neither adapter automatically. |

**Tool-only workflows do not need a Jev key.** If you choose the [Jev judgment adapter](../../packages/jev/README.md#call-jev), direct TypeSafe access uses `TYPESAFE_API_KEY`. Its [OpenRouter route](../../packages/jev/README.md#through-openrouter) uses `OPENROUTER_API_KEY` with `provider: 'openrouter'`, without a separate TypeSafe key. Configure that adapter in your backend; a model key saved on the AgentRun server is not automatically passed to it.

MCP itself needs no model-provider key. The local bridge generates its own connection authentication, exposed as `workflows.headers`; pass those headers to the native SDK as shown below.

## Register existing callbacks once

Expose the tools a learned workflow may call, using their canonical MCP names and actual schemas. Pass the same callback functions used by your existing tools. The following example assumes `readReleaseStatus`, `statusInputSchema`, `statusOutputSchema`, and `authorizeTool` already belong to your backend:

```ts
import { createWorkflowMcpBridge } from '@parcha/agentrun-client/workflows';
import * as workflowEngine from '@parcha/agentrun-dsl';

const workflows = await createWorkflowMcpBridge({
  engine: workflowEngine, // The backend explicitly owns and installs its interpreter.
  nativeMcpServerName: 'agentrun_workflows', // Use this exact name in your native MCP configuration below.
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

The bridge captures the engine functions, tool callbacks and host adapters at setup. It supplies its guarded `runEffect`, `runNode` and `runJudge` callbacks to the interpreter; the engine must use those callbacks for execution. Supplying an engine does not grant another tool or bypass the backend policy, schema checks, budgets or cancellation. If you provide model or judgment adapters, their request types are inferred from the supplied engine.

`execute(args, context)` receives `signal`, `runId`, `workflow`, and `idempotencyKey`. Honor cancellation and keep the callback's existing authorization and side-effect protections. A permission requiring confirmation must not silently become `allow`; this bridge does not supply an approval dialog. Unknown tool pricing can leave a proposed workflow pending owner review. Do not declare a metered API free just to get it accepted.

The optional `readOnly` declaration informs the native MCP approval policy. The bridge advertises a read-only workflow tool only when every allowed callback explicitly declares `readOnly: true` and no model or judge adapter is configured. Otherwise the bridge remains a potentially state-changing tool. This annotation does not replace the live `policy` check, and should never be used to bypass native approval for a tool that can write.

The bridge starts a loopback HTTP MCP endpoint. Its `url` and `headers` configure the native SDK; the wrapper binds each run to that bridge with an expiring capability. One bridge can serve multiple fresh runs. Keep it alive for the backend's lifetime and call `await workflows.close()` during shutdown. Keep the bearer headers and injected capabilities out of logs.

Set `nativeMcpServerName` to the exact host-configured name for this endpoint. This lets the wrapper correlate the native MCP envelope with a real bridge completion using the same capability, arguments, status and textual result, once per invocation. Other servers, unmatched calls and failed callbacks retain their ordinary evidence. If the name is omitted or cannot be verified by your backend, all native tool evidence is retained; the extra envelope may make the cost path read `handed_back`. The wrapper does not inspect or change a constructed Codex client's private configuration.

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
      alwaysLoad: true, // This bridge has one small tool; avoid deferred tool search.
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

Choose an unused MCP server name if `agentrun_workflows` already exists, and use that same name in `nativeMcpServerName`. The wrapper does not replace your native tools or open another turn to execute a workflow. The native agent calls the bridge's `learned_workflow` tool, and the workflow interpreter invokes only the callbacks you registered.

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

Once the agent has its `learning.compile_after` completed runs (20 by default), the compile turn reads them and drafts one executable workflow for the job. Static validation and a synthesized dry run qualify it for a check; they do not qualify it to answer a user's request. The next eligible fresh task runs the original agent without a learned workflow. After the native answer, the client checks the reserved draft against the same input and recorded tool calls, and sends its result in a run-scoped `workflow_check` event. The server compares that answer with the completed native answer using the existing promotion rules. Only a promoted champion can be delivered for ordinary reuse.

The initial SDK check has **one independently answered task** (`n = 1`), not a multi-case benchmark. It compares the owner's `agree_on` JSON fields when configured, otherwise the whole answer as JSON values or trimmed text. It does not ask a model to infer semantic equivalence; differently worded answers stay unpromoted unless the configured comparison establishes agreement. A mismatch, failed or incomplete native turn, missing tool recording, ambiguous input mapping, cancellation, or failed shadow execution does not promote the draft. These outcomes remain inspectable; they are not an instruction to repeat paid native tasks until one passes. A check draft stays out of the model's workflow list, so it cannot supply its own baseline answer. Owner corrections remain separate from candidate workflow promotion.

The client resolves simple inputs from the task's exact JSON or an unambiguous schema-compatible original tool input. A host with a more complex task-to-workflow mapping must supply an explicit resolver; the client does not invent a semantic mapping. A shadow call first uses matching recorded tool evidence. A missing read is refused by default. The host may explicitly enable `shadowReadFallback: true` for callbacks declared `readOnly: true`, under the same permission and execution limits. A write with no matching recording is skipped, never performed. Each recorded write can cover only one shadow call; the shadow cannot validate two writes from one original invocation. A failed recorded call is never retried. Optional host model/judge adapters still use the host's credentials and spending policy during a check; a tool-only check needs neither. Original callbacks and their credentials remain in the backend.

If the native turn includes a write, the check requires complete, non-overlapping tool start/end recordings and a serial candidate that consumes every original tool call exactly once, in order, including reads. Reordering or omitting a write cannot pass merely by producing the same answer. Unknown native tools and parallel write candidates leave the draft unpromoted. Buffered Codex results do not establish execution order, so they cannot validate a write-bearing turn; read-only checks still work. Reordering and reusing recorded reads is supported only for wholly read-only native turns. Asynchronous JSON Schema validators are unsupported and refused before invocation.

The initial bridge supports workflows over the explicitly registered callbacks. It supplies no default shell, arbitrary code executor, or model provider. Workflows needing agent or judge nodes require explicit backend `runNode` or `runJudge` adapters. The compile turn cannot assume those adapters exist when you have not supplied them. Your backend remains responsible for the adapter's model credentials, policies and cost.

When self-improving is Off, a fresh run receives no learned workflows. The bridge also revokes that run's capability when the native session finishes; it is not a permanent workflow endpoint for that agent. Corrections and workflows remain scoped to the stable AgentRun id and the accepted learning revision.

An existing agent registered by the basic wrapper with learning Off compiles nothing. Turn learning on in its agent settings (or set `learning: true` through the owner API) to enable compilation and checking. `learning` also accepts `{ compile_after: 5, agree_min: 0.9, alone_min: 0.7 }`: the first value controls when compilation is attempted; the other two are the promotion check's agreement and independent-answer thresholds. With one SDK check input, the draft must answer independently and agree with the native answer to pass these defaults. Adding the bridge or passing `learning: true` to a wrapper never overrides an existing owner's learning setting.

Server-run agents use the same champion-only serving rule and their existing replay and audit loop. This SDK integration adds the initial caller-side shadow check; it does not claim that the server can replay an arbitrary external application's tools or run its periodic native audit without that application's participation.

## Prove learning and reuse

The [workflow release-reporter examples](../../examples/sdk-learning/README.md#learn-an-executable-workflow) run the full sequence for either native SDK. They use two real, local, read-only MCP tools: fetch a fictional release status, then format exactly that observed status. Both native calls and the learned workflow use the same callback objects.

The test teaches the sequence, waits through the agent's compile cadence (`learning: { compile_after: 5 }`, set when the demo registers it; an agent compiles after 20 completed runs by default), and requires an active workflow generated by a real run. It next runs one ordinary native task to check the compiled draft, requires the server to promote that exact candidate, and then changes the requested service and version in a fresh session. Success requires the accepted revision, a completed MCP workflow invocation, both original callbacks running inside that workflow, and an answer matching their fresh result. A correct-looking answer produced by direct tool fallback fails that proof. A separate learning-Off agent receives the same fresh request for comparison.

The examples make paid native-model and server compile-turn calls only with `--live`. They never write a workflow file themselves, bypass owner review, lower the promotion threshold, or blindly repeat a failed paid call. Inspect the generated workflow and run evidence in Learning Dojo. This is an integration smoke test, not a claim that every repeated task should or will become a workflow.
