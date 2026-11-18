# Learning in existing JavaScript agent frameworks

The development client has optional wrappers for OpenAI Agents SDK and LangGraph. Use the client and server from the same reviewed checkout. These are integrations with the application's existing agent: the application still owns model credentials, task scheduling, tools, permissions, memory and cancellation. AgentRun records selected evidence and supplies learning for a fresh task. It cannot launch, stop or resume these external runs.

OpenAI Agents SDK is distinct from the [Codex SDK integration](codex-sdk-learning.md). LangGraph support covers the JavaScript graph API below; it does not establish support for Python LangGraph, the Deep Agents CLI, or every graph built by Deep Agents.

## OpenAI Agents SDK

Wrap the application's existing run function. A bound `Runner.run` does not expose its default input filter, so declare that filter explicitly, or pass `null` if the Runner has none. Per-call filters retain their native precedence.

```ts
import { withOpenAIAgentsLearning } from '@parcha/agentrun-client/openai-agents';

const run = withOpenAIAgentsLearning(existingRunner.run.bind(existingRunner), {
  agentId: 'release-agent',
  baseUrl: process.env.AGENTRUN_BASE_URL,
  apiKey: process.env.AGENTRUN_API_KEY,
  instructions: existingStandingInstructions,
  callModelInputFilter: existingRunnerConfig.callModelInputFilter ?? null,
  learning: true,
});
const result = await run(existingAgent, 'Check release readiness.', {
  session: existingSession,
  signal,
});
await run.flushLearning();
```

The original Agent, tools, guardrails, context and Session go to the native SDK. Relevant reference material is appended to transient model instructions, marked subordinate to the original policy and task; the wrapper does not mutate `Agent.instructions` or add reference messages to the Session. Normal native tool history still records tool calls and their arguments, including a workflow capability when used. The bridge revokes that capability when the task ends. The wrapper does not rewrite native history.

Provide a complete policy snapshot for dynamic instructions and any policy introduced by a model-input filter. Static Agent instructions are included in source evidence. Fresh text inputs and text outputs are supported. Input arrays, structured output agents, streaming, `RunState` resume and server conversation/response IDs are refused. Handoffs, hosted tools and other unsupported run evidence preserve the native outcome but prevent learning; inspect `flushLearning()` before treating the task as a learning example.

## LangGraph

Wrap the exact compiled graph your application already invokes. Since graph state is application-defined, provide three small adapters: extract the original task, add reference context, and extract the public answer. For a graph with a messages state:

```ts
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { withLangGraphLearning } from '@parcha/agentrun-client/langgraph';

type Task = { messages: BaseMessage[] };
const learningGraph = withLangGraphLearning(existingGraph, {
  agentId: 'release-graph',
  baseUrl: process.env.AGENTRUN_BASE_URL,
  apiKey: process.env.AGENTRUN_API_KEY,
  instructions: existingStandingInstructions,
  learning: true,
  inputText: (input: Task) => String(input.messages.at(-1)?.content ?? ''),
  withLearning: (input: Task, context) => ({
    ...input,
    messages: [new HumanMessage(context), ...input.messages],
  }),
  answerText: output => String(output.messages.at(-1)?.content ?? ''),
});

const result = await learningGraph.invoke(
  { messages: [new HumanMessage('Check release readiness.')] },
  { configurable: { thread_id: crypto.randomUUID() }, signal },
);
await learningGraph.flushLearning();
```

Keep system policy in the original graph. Supply its complete relevant policy as `instructions` for the server's compiler. The adapters should extract public text, not serialize private state or hidden reasoning. They are application code and remain responsible for preserving the task and schema.

The wrapper composes LangChain callbacks with the caller's callbacks and leaves the checkpointer and store on the original graph. Graph nodes must propagate their invocation config to models and tools so their callbacks can be observed. A run with no model callbacks or incomplete evidence cannot produce learning. Each checkpointed task requires a fresh `thread_id`; existing checkpoints, `Command` resume, static interrupts and streaming are refused before registration. A dynamic interrupt returns its original native result, reports the task cancelled, and creates no learning. Resume that task through the original graph.

## Executable workflows

Without a workflow bridge, the wrappers can report evidence and supply owner corrections. Automatic workflow learning requires the explicit [workflow bridge](sdk-workflow-learning.md): register the existing callbacks, schemas, actual prices and live permission policy, then pass the bridge as `workflows` to the wrapper. The host supplies its workflow interpreter. The wrapper does not discover or install native tools.

For OpenAI Agents SDK, connect the native MCP transport and include it in your host's Agent construction alongside its existing servers:

```ts
import { MCPServerStreamableHttp } from '@openai/agents';

// Create workflows as in the workflow cookbook, with nativeMcpServerName: 'agentrun'.
const mcp = new MCPServerStreamableHttp({
  name: 'agentrun',
  url: workflows.url,
  requestInit: { headers: workflows.headers },
});
await mcp.connect();
// Include mcp in the host Agent's mcpServers, keeping its existing servers and policy.
// Set mcpConfig.includeServerInToolNames: true for exact bridge-envelope correlation.
// Pass the same workflows object to withOpenAIAgentsLearning(..., { ...config, workflows }).
// Flush the wrapper before closing mcp and workflows at shutdown.
```

For a LangGraph application, connect an MCP client to the bridge and add one tool when constructing the original graph, alongside its existing tools:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// Create workflows as in the workflow cookbook, with nativeMcpServerName: 'agentrun'.
const mcp = new Client({ name: 'release-backend', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(workflows.url), {
  requestInit: { headers: workflows.headers },
}));
const learnedWorkflow = tool(async (args, options) => {
  const result = CallToolResultSchema.parse(await mcp.callTool(
    { name: 'learned_workflow', arguments: args }, undefined, { signal: options.signal },
  ));
  const text = result.content
    .filter(part => part.type === 'text')
    .map(part => part.text).join('\n');
  if (result.isError) throw new Error(text);
  return text;
}, {
  name: 'mcp__agentrun__learned_workflow',
  description: 'Execute a pinned workflow with its task capability and fresh input.',
  schema: z.object({ capability: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
});
// Include learnedWorkflow in the model's tools and graph's ToolNode, using your existing policy.
// Keep mcp and workflows alive across fresh tasks. At shutdown, flush learning, then close both.
```

The native model receives the pinned workflow's name, input schema and a task-scoped capability in its reference context. It chooses whether to call the tool. The bridge checks the original host policy before each callback, refuses `ask` or `deny`, and revokes the capability at completion or cancellation. It never executes model-supplied workflow JSON. Declare `price_usd: 0` only for callbacks that are actually free; unknown prices can leave a workflow pending owner approval.

`learning: true` opts in only when registering a missing agent. It preserves an existing owner's setting. To verify a two-run cycle, configure the test agent's `learning: { compile_after: 1 }`, complete and flush the first run, then start a fresh task. The production default cadence remains unchanged. Learning Off supplies no corrections or workflows.

## Evidence and limits

Both wrappers preserve native result/error objects. Persistence and learning failures are reported separately by `flushLearning()`; await it before shutdown or before checking the next task's learning. The upload contains the source task and policy, selected assistant text, tool identities/status and native usage. Raw native tool arguments/results and memory stay in the backend; bridge envelope correlation uses them locally. Unknown cost or cache splits remain unknown rather than becoming zero.

Conformance uses OpenAI Agents SDK 0.22.0 and LangGraph 1.7.5 with LangChain Core 1.4.1. These are test dependencies, not runtime dependencies of the wrappers. The [native server test](../../packages/serve/test/sdk-framework-learning.test.mjs) runs real SDK execution, HTTP receipts, compiler checks, versioned learning and MCP invocation; only model responses are scripted. It checks actual second-run consumption, withholding pending workflows and Learning Off. It proves the supported API path offline, not live model behavior or every framework configuration.
