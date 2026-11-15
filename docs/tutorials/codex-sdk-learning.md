# Add learning to a Codex SDK backend

Wrap the existing `Codex` instance and keep creating a fresh thread per backend request. AgentRun adds approved learning to the input and records the outcome; the native SDK still runs the task with your existing configuration, tools and credentials.

Use the client and server from the same reviewed development checkout. Install its built `packages/client` package into your backend until the wrapper exports are released. The example and type compatibility check use `@openai/codex-sdk` 0.167.2. This is the Codex SDK, not the separate OpenAI Agents SDK.

## Decorate the existing client

```ts
import { Codex } from '@openai/codex-sdk';
import { withCodexAgentLearning } from '@parcha/agentrun-client/codex';

const existingCodex = new Codex(); // Your existing provider/configuration stays here.
const codex = withCodexAgentLearning(existingCodex, {
  agentId: 'release-backend',
  name: 'Release backend',
  baseUrl: process.env.AGENTRUN_BASE_URL,
  apiKey: process.env.AGENTRUN_API_KEY,
  learning: true,
  instructions: 'Read the current release status. Never modify files or deploy anything.',
});

async function reportRelease(prompt: string, projectDirectory: string) {
  const thread = codex.startThread({
    workingDirectory: projectDirectory,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });
  const result = await thread.run(prompt);
  await codex.flushLearning();
  return result; // The exact original SDK result, with items, finalResponse and usage.
}
```

Keep your real `startThread` and `run` options, including the model, output schema and AbortSignal. The wrapper delegates to the existing instance; it does not recreate its private configuration. The required `instructions` snapshot must include the standing policy used by your backend and relevant project instructions. It is evidence for the independent grader, not a replacement for `AGENTS.md` or native instructions.

`learning: true` applies only on first registration of a missing id. Existing agents retain the console's self-improving toggle. Use the same id across fresh requests to share approved learning. Your backend owns job triggering and cancellation; AgentRun does not take over its queue or launch another Codex process to run the task.

## Stream without replacing native events

```ts
const thread = codex.startThread(existingThreadOptions);
const { events } = await thread.runStreamed(prompt, { signal: abortController.signal });
for await (const event of events) {
  deliverOriginalEvent(event);
}
await codex.flushLearning();
```

Here `existingThreadOptions`, `prompt`, `abortController` and `deliverOriginalEvent` are the values/handler in your backend. No work starts until you consume the stream. Event identity and order are preserved, and ending consumption closes the native iterator and records an unfinished task as cancelled.

AgentRun stores the original text input, instructions, assistant text, tool names/status, session id and reported token counters. It excludes raw tool arguments/stdout, reasoning, configuration and image bytes/paths. Text-plus-image input still reaches the native SDK unchanged apart from added text context, but a run containing images cannot produce new learning because the grader has not seen those images. `flushLearning()` reports that limitation; it does not replace the SDK's result.

Reflection runs on the AgentRun server without tools, followed by independent grading through the ordinary learning pipeline. No extra Codex turn enters the user's thread. Accepted notes and skill text appear as task context on the next fresh thread. The basic wrapper installs no project files or native tools. Configure the server's reflection/grading model separately; those calls add usage, and your native SDK credentials remain in your backend.

Flush before a worker exits, and between a teaching run and its reuse test. A failed upload or incomplete trace prevents new learning and is reported by `flushLearning()`. A normal checked rejection is not a transport failure; inspect it in Learning Dojo. Model calls are never blindly repeated after an uncertain failure.

Only one task per wrapped thread is supported initially. A second `run`/`runStreamed` call on that thread, or `resumeThread`, is explicitly refused. Keep the original client for conversations outside this integration.

## Verify a real tool and fresh-run reuse

Run the [live release-reporter example](../../examples/sdk-learning/README.md). Codex reads a fictional status file with its normal shell in a read-only workspace. The example teaches a preference, checks the accepted note or skill and seed revision, and compares a fresh reuse run with a learning-Off control. It leaves the recorded agents/runs in your console for inspection.

The native Linux shell sandbox requires namespace support. For a restricted container that cannot create those namespaces, run the example with `--live --mcp`. This uses a real read-only `release_status` MCP service configured on the existing Codex client and keeps the read-only sandbox. Both modes check successful tool completion and the actual release facts, not just whether a tool was attempted. The wrapper itself does not alter native tools or sandbox permissions.

Native SDK reference: [OpenAI's Codex TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md).

SDK run evidence must finish within one hour of registration. A backend task that exceeds that deadline is not replayed; AgentRun records an unknown execution outcome and does not infer new learning.
