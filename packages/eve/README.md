# AgentRun for eve

An additive extension for an existing [eve](https://github.com/vercel/eve) agent. eve keeps its
model, tools, credentials, permissions, channels and durable execution. AgentRun records each
turn and supplies independently checked notes, skills and opt-in workflows to later turns.

This package currently builds from this repository and is held from npm publication. It targets
**eve 1.0.0** and requires the matching AgentRun server with the `eve` SDK runtime contract.
See the [cookbook](../../docs/tutorials/eve-learning.md) and [live example](../../examples/eve-learning/README.md).

Mount the built package in `agent/extensions/agentrun.ts`:

```ts
import agentrun from '@parcha/agentrun-eve';
import { instructions } from '../lib/policy.js';

export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!, // Your server's /v2 API
  apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: 'release-assistant',
  name: 'Release assistant',
  instructions, // Share the complete original standing policy, not the learning supplement.
});
```

The first normal eve turn registers the connected agent with learning off. Enable
**Self-improving** on its AgentRun page; the next turn pins its learning revision. Alternatively,
`learning: true` opts in on first registration only. An existing agent's setting always wins.
Removing the extension restores the original eve integration; it does not delete AgentRun history.

## What happens per turn

1. Before the first model call, admit a run with a key derived from the agent, eve session and turn.
2. Keep its receipt and learning snapshot in eve's private, durable extension state. Repeated model
   calls and retries use the same snapshot. Instructions receive reference text, never credentials.
3. At settlement, combine eve's session stream with a bounded private buffer of its hook events.
   eve flushes the current step after hooks finish, so the buffer supplies that step's recorded
   facts before they appear in durable history. Normalize through the exact turn-settled event;
   later delivery housekeeping cannot change a retry. Upload visible assistant text, tool names/outcomes, model and reported usage.
   Raw tool inputs/results, reasoning and native credentials remain with eve.
4. Submit the original outcome once. AgentRun's ordinary runner reflects and independently checks
   proposals. A future fresh turn receives only accepted learning; submission alone is not promotion.

Opening AgentRun does not relocate the eve process or let AgentRun start arbitrary eve jobs. Run
and edit actions direct the coding agent back to the existing eve project.

## Executable learned workflows

Notes and skills work with the mount above. To enable executable workflows, add an explicit
`workflows` configuration containing a trusted workflow engine, live policy and read-only
callbacks. Bind the **same original functions** used by your eve tools; do not recreate their
permissions, credentials or business logic in the extension.

```ts
import { inspectWorkflow, runWorkflow, resolveSchemaForWorkflow } from '@parcha/agentrun-dsl';
import { releaseStatus, releaseInputSchema, releaseOutputSchema } from '../lib/release-tools.js';

// Add this property to the existing agentrun({...}) mount:
const workflows = {
  engine: { inspectWorkflow, runWorkflow, resolveSchemaForWorkflow },
  policy: () => 'allow' as const, // Replace with your existing live authorization policy.
  tools: [{
    name: 'mcp:release/status',       // Stable canonical identity in checked workflows.
    nativeName: 'release_status',    // Exact eve runtime tool name, including any namespace.
    description: 'Read the current release status.',
    input_schema: releaseInputSchema,
    output_schema: releaseOutputSchema,
    permission: 'allow' as const,
    readOnly: true as const,
    execute: releaseStatus,          // The original callback, with its original authorization.
  }],
};
```

The optional `toolName` defaults to `agentrun__learned_workflow`, for a mount named
`agent/extensions/agentrun.ts`. With a different mount name, set `toolName` to the exact resulting
eve runtime name, for example `my_learning__learned_workflow`. Alias matching is explicit;
similar-looking tool names are never inferred. The typed mount configuration carries callbacks
locally; only schemas and permission metadata are sent to AgentRun.

Enable **Self-improving** after connecting. The ordinary AgentRun reflection/checking process can
learn a workflow from complete native traces. The next fresh turn receives only workflows pinned
to that turn's accepted learning revision. When eve chooses `learned_workflow`, the extension
creates a local MCP bridge inside that native tool step and invokes the original callbacks through
the bridge's schema checks and live policy. No model-visible URL, auth token or capability is needed.
Arguments and callback results stay with eve; signed, run-scoped lifecycle metadata survives durable
replay and lets AgentRun distinguish actual workflow execution from an unverified claim.

There is **one logical workflow invocation per eve turn**, including failed attempts. The first
ordered native request reserves the turn before parallel tool steps run. A durably recorded result
can be replayed without invoking its callbacks again. If eve retries before that checkpoint,
read-only callbacks may repeat; this is not exactly-once execution. Consequently this adapter
rejects mutating callbacks and host model/judge adapters, and never automatically retries an
uncertain workflow. Existing callback permissions still apply: `ask` and `deny` refuse execution.
Turning learning Off also refuses new workflow invocations in a turn admitted earlier; it does not
cancel a callback already dispatched. Fresh Off turns expose no executable workflow tool.

## Boundaries and recovery

- This initial adapter learns from complete, fresh, text-only turns. Conversation follow-ups,
  steering, missing or referenced evidence, and child work are not claimed as complete learning
  evidence. Accepted learning can still be supplied; original task and policy remain authoritative.
- Notes and skills are reference text. Workflow execution is opt-in through the explicit bindings
  above; the extension does not install arbitrary tools or rewrite the project.
- Admission requires AgentRun to be reachable. Once native work completes, a delivery failure
  is logged without replacing eve's answer. A pending receipt is retried on the next turn in the
  same eve session, with the same upload keys. A session that never resumes may need operator
  recovery; hooks are not an exactly-once background delivery service.
- AgentRun evidence receipts expire after one hour. An expired receipt is closed without claiming
  learning; it does not block new turns. History reads and evidence uploads are bounded. Unknown
  usage stays unknown, not zero.
- Keep the extension mount name stable. eve namespaces durable state by mount and session.
  Keep server and agent identity stable for a running session. Use separate agent IDs and scoped
  server credentials for separate customers; this extension does not invent tenant isolation.
- Turning learning off affects the next turn. A running turn keeps the revision it started with,
  and an existing conversation can naturally remember its prior messages. Use a fresh session
  to compare learning on and off.

## Development

From the repository root, build the client first, then this extension:

```sh
npm run build -w @parcha/agentrun-client
npm run build -w @parcha/agentrun-eve
npm test -w @parcha/agentrun-eve
```

The build uses eve's extension compiler and checks the authored TypeScript. Tests import the
same `.mjs` files that the package ships. No model credentials are needed for unit tests.
