# Add self-improvement to an existing Vercel eve agent

Mount the AgentRun eve extension in your existing eve project. Continue invoking eve normally: it keeps the model, tools, credentials, approvals, channels and durable execution. AgentRun records each supported turn, compiles repeated tool procedures, checks a draft against an independent native answer, and supplies promoted workflows to later turns.

This integration targets **eve 1.0.0**, **Node 24.22.3 or newer**, and an AgentRun server supporting the `eve` SDK runtime. The client, extension and server must come from the matching reviewed candidate or release. `@parcha/agentrun-eve` is currently held from npm publication; a built candidate can be installed without an AgentRun checkout.

## Install and mount

Unpack the candidate's three package archives and checksum file. From your existing eve project's directory, install them together:

```sh
npm install /path/to/candidate/parcha-agentrun-client-*.tgz \
  /path/to/candidate/parcha-agentrun-dsl-*.tgz \
  /path/to/candidate/parcha-agentrun-eve-*.tgz
```

This installs normal npm package contents with no workspace links. Keep the project's existing eve, model provider and tools. After the reviewed packages are published, the registry equivalent is `npm install @parcha/agentrun-eve`; the unpublished candidate requires the archives above.

The [runnable source example](../../examples/eve-learning/README.md) uses local packages for repository development. Consumers use the built archives instead.

Add `agent/extensions/agentrun.ts` in the original eve project:

```ts
import agentrun from '@parcha/agentrun-eve';
import { POLICY } from '../lib/policy.js';

export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!, // AgentRun's API URL, ending in /v2.
  apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: process.env.AGENTRUN_AGENT_ID!, // Keep this stable across deployments.
  name: 'Release reporter',
  instructions: POLICY,                   // The original standing instructions.
  learning: false,                        // Initial registration; existing settings win.
});
```

`POLICY` is the same text your original eve instructions use. Include relevant standing application policy for workflow compilation; do not substitute learned context or omit restrictions. No change to the original tool callbacks or model configuration is required. Keep the extension mount name and agent id stable so retries and later turns refer to the same agent.

Set `AGENTRUN_BASE_URL`, `AGENTRUN_API_KEY` and `AGENTRUN_AGENT_ID` in eve's server environment. The URL is the AgentRun API ending `/v2`; the key is an AgentRun API key, separate from the existing model key. Keep model and tool credentials where the application already stores them. Rebuild/redeploy eve through its usual process. The extension contacts AgentRun from the eve backend; the AgentRun server does not need inbound access to your eve application. No modification of the original model, tools or `agent.ts` build options is required.

Use a separate AgentRun agent id for separate applications or trust boundaries. One stable id shares its corrections and workflows across that agent's sessions; it is not a per-user isolation mechanism. Retain your existing eve route authentication and authorization.

Production `eve start` requires authenticated session requests. Keep the application's existing route policy; clients used to test this example must satisfy it too. The example scripts accept `EVE_BEARER_TOKEN` for bearer-authenticated routes. A public health response does not verify session access. See eve's [route-authentication guide](https://github.com/vercel/eve/blob/main/docs/guides/auth-and-route-protection.md).

## Connect first, then enable learning

Run one ordinary task through eve. The extension registers the agent if necessary and the console shows **Vercel eve**, its actual reported model, the run and available token usage. Run and edit handoffs point back to the original eve application; AgentRun's managed-run endpoint cannot execute an eve agent.

With `learning: false`, recording works without a server compilation model. To enable learning, configure a model in AgentRun Settings and enable **Self-improving** on the agent's Learning tab. `learning: true` is an alternative initial opt-in for a new id; existing server settings always win. The base extension delivers owner-authored `corrections.md`. Automatic workflow compilation additionally requires the explicit callback bindings below. AgentRun no longer creates autonomous notes or learned skill files.

For each supported turn:

1. Before the first ordinary model call, the extension registers one AgentRun run and pins its corrections/workflow revision.
2. Dynamic instructions add the pinned owner corrections while eve keeps its original tools and execution.
3. When eve settles the turn, the extension combines durable history with its bounded private hook-event buffer and reports the outcome. This handles eve flushing a step only after its hooks finish.
4. With workflow bindings and enough completed traces, AgentRun compiles a repeatable procedure, checks its structure and synthesized dry run, and commits a passing draft.
5. A fresh native turn receives that draft only as a reserved check, outside its model context. Eve answers with its original tools. The shared client checks the draft in process against the completed native turn's recorded tool evidence; the server compares the two answers. Only a promoted workflow is available to a later turn.

The answer can finish before compilation. Wait for the recorded learning result before testing the new workflow. A pinned revision proves delivery; actual original callbacks and canonical server events prove execution. Owner corrections can be edited through the console or version-checked Corrections API; they are not automatically inferred from ordinary SDK task messages.

## Retry and evidence boundaries

A deterministic key ties admission to the eve session and turn, so repeating admission after a lost response resolves to the same AgentRun receipt. Committed turn evidence is uploaded with stable sequence numbers. Retrying evidence delivery does not rerun the model or original tools. The next turn makes a bounded retry of pending delivery from the same session. A refused earlier upload is logged for that receipt and does not fail the new native turn. If the bounded backlog is full, the native turn continues without new learning admission until entries resolve or expire. Keep eve's durable state and stream retention intact; these retries do not rerun the original model or tools.

Missing, unsupported or oversized evidence is not treated as a complete training trace. Failed and cancelled turns remain observable without silently committing new learning. Usage that the native runtime does not report stays unknown. Evidence writes expire one hour after admission; an expired task is not replayed to recover telemetry.

The base extension supplies owner-authored corrections. It does not install local skill files, import old eve history or replace eve memory providers. Executable workflows require the explicit callback bindings below; adding the base extension does not implicitly grant those capabilities.

Turning learning Off stops delivery to future turns. It cannot erase learning already included in an open conversation. Use a fresh session for the Off comparison.

## Execute promoted workflows with existing tools

Optionally give the extension an interpreter and a catalog of the **same functions** your existing authored eve tools execute:

Add the matching `@parcha/agentrun-dsl` as a direct application dependency when importing it below; the candidate install already does this. The extension declares the interpreter's package-layout requirement in its own build metadata, so eve preserves its schema assets without changes to the application's `defineAgent` configuration. Restart eve after changing packages.

```ts
import agentrun from '@parcha/agentrun-eve';
import * as workflowEngine from '@parcha/agentrun-dsl';
import { POLICY } from '../lib/policy.js';
import { readReleaseStatus, statusSchema } from '../lib/release-tools.js';

export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!,
  apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: 'release-reporter',
  instructions: POLICY,
  learning: false,
  workflows: {
    engine: workflowEngine,
    tools: [{
      name: 'mcp:release/release_status',
      nativeName: 'release_status', // Exact name eve records for the original tool.
      description: 'Read current release status for a service.',
      input_schema: {
        type: 'object', required: ['service'], additionalProperties: false,
        properties: { service: { type: 'string' } },
      },
      output_schema: statusSchema,
      permission: 'allow', price_usd: 0, readOnly: true,
      execute: readReleaseStatus, // Also called by the original authored eve tool.
    }],
    policy: () => 'allow', // Replace with your application's current permission check.
    maxToolCalls: 8,
    maxDurationMs: 30_000,
  },
});
```

An `execute(args, ctx)` callback receives an abort signal, AgentRun run id, workflow name and idempotency key. Continue enforcing the application's authorization inside the callback or policy. Names, input/output schemas and read-only declarations must describe the actual original tool. `nativeName` explicitly maps eve's recorded tool name to the canonical workflow name; the extension does not infer permissions or tools from the model provider.

Workflow learning (`learning: true`, or an object such as `learning: { compile_after: 5 }`) enables normal compilation of repeated successful patterns. The default threshold is 20 completed native runs; prior completed Off runs also count. A smaller threshold changes when compilation is attempted, not the structural or dry-run checks. Passing drafts commit directly but are withheld from ordinary execution. A fresh native turn supplies an independent answer and its recorded tool evidence for an in-process shadow check. The server promotes the draft only when that check answers independently and agrees with the native answer. The initial check uses one task (`n = 1`) and compares exact answers, or the owner's configured `agree_on` JSON fields; it does not invoke a semantic grader. A mismatch, incomplete evidence or a skipped call leaves it unavailable. Compilation is not promotion. Initial mount settings apply only to new ids. Change an existing agent through the version-checked Agents API or console.

On a later native turn, the extension pins the promoted workflow revision and advertises its name and input schema. Eve can call `agentrun__learned_workflow` with `{ name, input }`. Within that native tool execution the extension calls the shared workflow executor directly in process. Eve does not open a localhost MCP server for this call. The interpreter runs only explicitly bound original callbacks with fresh arguments. AgentRun stores compiled workflows and receives execution records; tools and their credentials stay with eve. There is no separate public MCP service to deploy.

The model sees the workflow's textual result. AgentRun records a workflow invocation and child tool metadata; private callback results, run credentials and signed evidence do not become model instructions. Original native tools remain available. A workflow is an optional execution path, not an automatic side effect of receiving learned context.

The first eve workflow bridge supports **explicitly read-only callbacks**. It refuses model/judge adapters and does not grant shell or workflow code execution. A tool-only workflow needs no Jev key; ordinary eve model calls and AgentRun's compiler calls still need their own configured routes. The extension permits one logical workflow invocation per turn. A durably recorded result replays without invoking callbacks again; a native retry before that checkpoint may repeat read-only callbacks. This is not exactly-once execution, and uncertain workflows are not automatically retried by the bridge. Turning full learning Off also blocks a new workflow invocation in a turn admitted earlier; an invocation already running is not undone.

Keep the mount named `agent/extensions/agentrun.ts`. If you intentionally use another name, set `workflows.toolName` to the exact namespaced eve runtime tool name. That name is used for evidence correlation as well as instructions.

The [executable workflow example](../../examples/eve-learning/README.md#learn-and-execute-a-workflow-with-the-original-tools) proves run-owned compilation, static/dry-run validation, an independent shadow check and promotion before changed-input reuse through the same two callbacks, and a fresh Off control on the same agent. It saves resumable evidence and stops on direct-tool fallback, pending review or incomplete history.

## Run the proof

The [release-reporter example](../../examples/eve-learning/README.md) contains two distinct proofs:

- **Owner corrections:** original baseline → connect → Off task → explicit owner correction → fresh-session reuse with different tool data → same-agent Off control. This proves correction delivery, not automatic learning.
- **Automatic workflows:** original baseline → connect the original callbacks → Off task → enable workflow learning → repeated native tasks → new compiled workflow → independent native shadow check → promotion → fresh-session execution with original callbacks → same-agent Off control. Compiler attempts/digest, run-owned commit, fresh callback observations and the server's parent/child timeline are required. The validator never writes corrections or seeds workflows.

Both checkpoint confirmed sessions and stop on uncertain submissions rather than resending paid tasks.

Official eve references: [extensions](https://github.com/vercel/eve/blob/main/docs/extensions/index.md), [dynamic instructions](https://github.com/vercel/eve/blob/main/docs/instructions.mdx) and [the client SDK](https://github.com/vercel/eve/blob/main/docs/guides/client/index.mdx).
