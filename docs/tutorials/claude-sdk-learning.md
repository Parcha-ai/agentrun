# Add learning to a Claude Agent SDK backend

Wrap your existing `query` function, keep its options and tools, and give the backend agent a stable AgentRun id. Each fresh session receives the agent's learning (its owner's corrections, and promoted workflows through the bridge) before its first task. The application still starts the work and handles the stream.

This integration requires the client and server from the same reviewed development checkout. Use its built `packages/client` package in your backend; these new exports are not yet a published-release guarantee. The executable example is tested against `@anthropic-ai/claude-agent-sdk` 0.3.286.

## Change the call site

```ts
import { query as nativeQuery } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeAgentLearning } from '@parcha/agentrun-client/claude';

const query = withClaudeAgentLearning(nativeQuery, {
  agentId: 'support-backend',
  name: 'Support backend',
  baseUrl: process.env.AGENTRUN_BASE_URL, // Your server's API, ending /v2.
  apiKey: process.env.AGENTRUN_API_KEY,
  learning: true,
  // Include relevant project-file policy if it is not in options.systemPrompt.
  instructions: 'Answer from our knowledge base. Never change customer account data.',
});

// Keep your real systemPrompt, MCP servers, allowedTools, hooks, model and permissions here.
async function answerRequest(prompt: string, existingOptions: Parameters<typeof nativeQuery>[0]['options']) {
  for await (const event of query({ prompt, options: existingOptions })) {
    deliverOriginalEvent(event); // Your existing event handling.
  }
  await query.flushLearning();
}
```

`deliverOriginalEvent` represents your existing stream handler. The wrapper preserves the original event objects, native control methods, tools and options. It adds the owner's corrections as lower-priority task context; it does not replace your system prompt. Programmatic system instructions and the selected named agent's prompt are recorded with the run. Supply `instructions` for relevant policy in project files that the SDK does not expose.

`learning: true` opts in only when this stable id is first registered. Existing agents keep their current self-improving setting; change that setting in the console. Backend agents run when your application calls the SDK, not when the AgentRun runner schedules another model job. Continue to use your original cancellation controller or query controls.

## What happens after the answer

The original task result reaches your application before AgentRun finishes recording it. AgentRun records the original request, standing instructions, assistant text, tool names/status, session id and reported usage. The wrapper does not upload raw tool arguments/results, SDK configuration, credentials or reasoning blocks.

An SDK task carries no owner feedback of its own. The agent's `corrections.md` changes when its owner edits it: in the console's Learning tab, or with `PUT /v2/agents/{id}/learning/corrections` on the version just read. A later fresh session is given that file whole, under `# Learned`. The wrapper never starts a hidden second turn in your Claude conversation, installs no local files and adds no native tools. Once the agent has its `learning.compile_after` completed runs (20 by default), the server's compile turn may draft a workflow from them; to let a promoted workflow call your existing tools, explicitly configure the [workflow MCP bridge](sdk-workflow-learning.md).

Call `await query.flushLearning()` before shutting down a worker or starting the next run. It waits for the pending evidence and for the run's learning (a compile turn, when one is due) to settle. Persistence failures, a failed learning turn and timeouts are observable errors, not successful learning. The original SDK failure/result remains unchanged. For a request server, you can deliver the answer first and wait in your existing background-job lifecycle, but keep the process alive until flushing finishes.

The initial integration supports one string prompt in a fresh session. Resuming or continuing an existing conversation and streaming input prompts are explicitly refused. Native model credentials stay with your backend; AgentRun needs a separate API key for recording, and its own configured model for the compile turn. Those additional model calls incur usage.

SDK run evidence must finish within one hour of registration. A backend task that exceeds that deadline is not replayed; AgentRun records an unknown execution outcome and does not infer new learning.

## Prove reuse with a real custom tool

Run the [live release-reporter example](../../examples/sdk-learning/README.md). It retains a real `createSdkMcpServer` tool, adds the owner's formatting preference to `corrections.md` as a correction, and checks that a fresh run starts from that revision, is given the correction and follows it. A separate learning-Off agent receives the same test request for comparison.

SDK behavior reference: [Anthropic's Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview).
