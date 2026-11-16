# Add self-improvement to an existing Vercel eve agent

Mount the AgentRun eve extension in your existing eve project. Continue invoking eve normally: it keeps the model, tools, credentials, approvals, channels and durable execution. AgentRun records each supported turn, checks proposed learning, and supplies the accepted revision to the next turn.

This integration targets **eve 1.0.0** and the client, extension and AgentRun server from the same reviewed development checkout. `@parcha/agentrun-eve` is currently a private package, not an advertised npm release.

## Install and mount

Build the checkout first, including the client and extension. For a local development integration, add its built extension and client packages to your eve project's dependencies using your package manager's local-package support. The [runnable example](../../examples/eve-learning/README.md) already declares those local dependencies and pins eve and its model provider.

Add `agent/extensions/agentrun.ts` in the original eve project:

```ts
import agentrun from '@parcha/agentrun-eve';
import { POLICY } from '../lib/policy.js';

export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!, // AgentRun's API URL, ending in /v2.
  apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: 'release-reporter',             // Keep this stable across deployments.
  name: 'Release reporter',
  instructions: POLICY,                   // The original standing instructions.
  learning: false,                        // Initial registration; existing settings win.
});
```

`POLICY` is the same text your original eve instructions use. Include relevant standing application policy for the independent checker; do not substitute learned context or omit restrictions. No change to the original tool callbacks or model configuration is required. Keep the extension mount name and agent id stable so retries and later turns refer to the same agent.

Set `AGENTRUN_BASE_URL` and `AGENTRUN_API_KEY` in eve's server environment. Keep model and tool credentials where the application already stores them. Rebuild/redeploy eve through its usual process. The extension contacts AgentRun from the eve backend; the AgentRun server does not need inbound access to your eve application.

Use a separate AgentRun agent id for separate applications or trust boundaries. One stable id shares its accepted learning across that agent's sessions; it is not a per-user isolation mechanism. Retain your existing eve route authentication and authorization.

## Connect first, then enable learning

Run one ordinary task through eve. The extension registers the agent if necessary and the console shows **Vercel eve**, its actual reported model, the run and available token usage. Run and edit handoffs point back to the original eve application; AgentRun's managed-run endpoint cannot execute an eve agent.

With `learning: false`, recording works without a server reflection model. To enable self-improvement, configure a server reflection/grading model in AgentRun Settings and use the agent's Learning tab. `learning: true` is an alternative initial opt-in when registering a new id; it does not change an existing agent's setting. The console setting controls subsequent turns.

For each supported turn:

1. Before the first ordinary model call, the extension registers one AgentRun run and pins its accepted notes and skills.
2. Dynamic instructions add that pinned learning while eve continues with its original tools and execution.
3. When eve records the settled turn, the extension combines durable history with its bounded private hook-event buffer and reports the outcome to AgentRun. This handles eve flushing a step only after its hooks finish.
4. AgentRun reflects and independently checks the proposed lesson. Approved notes and skills become eligible for a later turn; proposals needing review stay pending.

Wait for the recorded run's learning result before starting a test that must use its latest lesson. The eve answer can finish before checking does. An accepted revision on the next run proves delivery; a successful task alone does not prove the agent used it. The example also checks changed tool data and an Off control.

## Retry and evidence boundaries

A deterministic key ties admission to the eve session and turn, so repeating admission after a lost response resolves to the same AgentRun receipt. Committed turn evidence is uploaded with stable sequence numbers. Retrying evidence delivery does not rerun the model or original tools. The next turn retries pending delivery from the same session; keep eve's durable state and stream retention intact.

Missing, unsupported or oversized evidence is not treated as a complete training trace. Failed and cancelled turns remain observable without silently promoting new learning. Usage that the native runtime does not report stays unknown. Evidence writes expire one hour after admission; an expired task is not replayed to recover telemetry.

This initial extension supplies accepted notes and skill text. It does not install local skill files, import old eve history, replace eve memory providers, or expose the original native tools for learned workflow execution. The separate [SDK workflow MCP bridge](sdk-workflow-learning.md) requires explicit tool callback bindings; adding the eve extension does not implicitly grant those capabilities.

Turning learning Off stops delivery to future turns. It cannot erase learning already included in an open conversation. Use a fresh session for the Off comparison.

## Run the proof

Follow the [existing eve release-reporter example](../../examples/eve-learning/README.md): original baseline → add one extension mount → connected task with learning Off → enable learning → teach a preference → wait for independent acceptance → fresh-session reuse on different tool data → fresh-session Off control. Do not seed a lesson manually or force-approve a rejected candidate.

Official eve references: [extensions](https://github.com/vercel/eve/blob/main/docs/extensions/index.md), [dynamic instructions](https://github.com/vercel/eve/blob/main/docs/instructions.mdx) and [the client SDK](https://github.com/vercel/eve/blob/main/docs/guides/client/index.mdx).
