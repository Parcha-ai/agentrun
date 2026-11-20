# AgentRun for eve

An additive extension for an existing [eve](https://github.com/vercel/eve) agent. eve keeps its
model, tools, credentials, permissions, channels and durable execution. AgentRun records each
turn and supplies the owner's corrections and opt-in learned workflows to later turns.

Targets **eve 1.0.0** and **Node 24.22.3 or newer**. The AgentRun server must support the `eve`
SDK runtime and have a compilation model route and key configured before Self-improving can be
enabled, even for a mount without workflow bindings. Such a mount supplies owner corrections but
does not itself make a compilation call.
The package is a tested release candidate, held from npm publication. Install the candidate's
three archives together in your **existing eve project**:

```sh
npm install /path/to/candidate/parcha-agentrun-client-*.tgz \
  /path/to/candidate/parcha-agentrun-dsl-*.tgz \
  /path/to/candidate/parcha-agentrun-eve-*.tgz
```

These are built packages, not workspace links; no AgentRun checkout is needed in the application.
After a reviewed release publishes them, the registry install will be `npm install @parcha/agentrun-eve`.
Do not use that registry command for this unpublished candidate.

## Check the installation without credentials

After installing the archives, save this as `check-agentrun.mjs` and run `node check-agentrun.mjs`.
It checks the installed extension and workflow entry points, validates a mount, and confirms that
learning defaults to Off. It does not connect an agent, contact a server, or call a model; real
learning still needs the authenticated setup below.

```js
import assert from 'node:assert/strict';
import agentrun from '@parcha/agentrun-eve';
import { learned_workflow } from '@parcha/agentrun-eve/tools';

const mount = agentrun({
  baseUrl: 'https://agentrun.example/v2',
  apiKey: 'fake-test-key',
  agentId: 'installation-check',
  instructions: 'Keep the original tools and permissions.',
});
assert.ok(mount);
assert.ok(learned_workflow);
assert.equal(agentrun.config.learning, false);
console.log('AgentRun extension loaded; learning defaults to Off. No agent was connected.');
```

## Connect your existing agent

Add one file, `agent/extensions/agentrun.ts`:

```ts
import agentrun from '@parcha/agentrun-eve';
import { instructions } from '../lib/policy.js';

export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!, // Your server's /v2 API
  apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: process.env.AGENTRUN_AGENT_ID!,
  name: 'Release assistant', // Your existing application's display name.
  instructions, // Share the complete original standing policy, not the learning supplement.
});
```

Use the same original standing instructions as the existing eve agent, including its restrictions.
Set `AGENTRUN_BASE_URL` (the server's API URL ending `/v2`), `AGENTRUN_API_KEY` (an AgentRun key),
and a stable `AGENTRUN_AGENT_ID` in the eve backend's environment. Keep secrets out of this file.
The agent's existing model and tool keys stay where they are.

Restart or redeploy eve normally and run one ordinary task. It registers the connected agent with
learning off. Open that agent's **Learning** tab and enable **Self-improving**.
The next fresh turn pins the owner's corrections from `corrections.md`. Alternatively, `learning: true`
in this mount opts in on first registration only. Without workflow bindings the extension records
turns and supplies those corrections; it cannot learn executable workflows.
With explicit workflow bindings, `learning: { compile_after: 5 }` opts a new agent into
workflow learning with a five-completed-run compilation threshold (the server default is 20).
The mount exposes the compilation cadence only; promotion thresholds stay in the agent's server
settings. An existing agent's console setting always wins. The extension declares its own build dependencies;
the application's model, tools and `agent.ts` build configuration need no changes.

Removing the extension restores the original eve integration; it does not delete AgentRun history.
See the [cookbook](https://github.com/Parcha-ai/agentrun/blob/main/docs/tutorials/eve-learning.md)
and [runnable example](https://github.com/Parcha-ai/agentrun/tree/main/examples/eve-learning)
in the matching source release. The candidate source includes these files before they reach main.

To check the context path, add a harmless owner correction in AgentRun, then start a fresh eve
task that uses it. Confirm that run names the correction's pinned revision. To test automatic
workflow learning, use the bound original tools for enough complete tasks to reach the compilation
threshold, then follow the cookbook's fresh-session reuse and Learning Off comparison. Switching
self-improvement Off leaves the original tools working without learning on the next fresh task.

If setup fails, check the backend's environment and API URL first. An unsupported `eve` runtime
means the server needs the matching release; an agent-id/runtime conflict needs a separate id for
this eve application. If runs are recorded but no workflow appears, check the server's compilation
model route, explicit tool bindings and completed-run threshold. The extension does not infer
corrections or create a workflow after every successful task.

## What happens per turn

1. Before the first model call, admit a run with a key derived from the agent, eve session and turn.
2. Keep its receipt and learning snapshot in eve's private, durable extension state. Repeated model
   calls and retries use the same snapshot. Instructions receive reference text, never credentials.
3. At settlement, combine eve's session stream with a bounded private buffer of its hook events.
   eve flushes the current step after hooks finish, so the buffer supplies that step's recorded
   facts before they appear in durable history. Normalize through the exact turn-settled event;
   later delivery housekeeping cannot change a retry. Upload visible assistant text, tool names/outcomes, model and reported usage.
   Raw tool inputs/results, reasoning and native credentials remain with eve.
4. Submit the original outcome once. Once enough complete native runs are recorded, AgentRun's
   ordinary runner compiles workflow drafts using the owner's corrections and the bound tool
   schemas and commits them as drafts. A later native turn receives one candidate privately for a
   shadow check after its own answer. The shared client replays recorded tool results and compares
   the workflow answer through the server's promotion gate. Only promoted workflows become
   reusable context on subsequent turns. Neither compilation nor receiving a check executes a workflow for the user.

Evidence is bounded per turn. An oversized or conflicting buffer skips that turn’s learning;
later native turns can still proceed. A missing start boundary or a full delivery backlog
continues native execution without admitting another learning receipt. Unreported receipts
expire without an invented completion.

Opening AgentRun does not relocate the eve process or let AgentRun start arbitrary eve jobs. Run
and edit actions direct the coding agent back to the existing eve project.

## Executable learned workflows

Owner corrections work with the mount above. To enable executable workflows, add an explicit
`workflows` configuration containing a trusted workflow engine, live policy and read-only
callbacks. Bind the **same original functions** used by your eve tools; do not recreate their
permissions, credentials or business logic in the extension.

If you import the interpreter in application code as below, also declare `@parcha/agentrun-dsl`
as a direct dependency at the candidate's matching version (the archive install above already does).
The extension's build metadata preserves its package assets; no application-level build override is required.

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

After binding the original tools, enable **Self-improving** in the agent's learning settings.
The server can compile a workflow from complete native traces once the configured threshold is
reached. A separate native turn checks the draft against the agent's own answer using its recorded
tool results. The server applies the same promotion gate as other connected harnesses; mismatched,
incomplete or untested drafts are withheld. A subsequent turn can choose a promoted workflow
when it fits, or use its original tools directly. When eve chooses `learned_workflow`, the extension
executes through the shared in-process bridge, with the original callbacks, schema checks and live
policy. No loopback MCP server or model-visible URL, token or capability is needed.
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
- Owner corrections are reference text. Workflow execution is opt-in through the explicit bindings
  above; the extension does not install arbitrary tools or rewrite the project.
- Admission requires AgentRun to be reachable. Once native work completes, a delivery failure
  is logged without replacing eve's answer. A pending receipt is retried on the next turn in the
  same eve session, with the same upload keys. A refused earlier delivery never rejects a new native
  turn; a full backlog continues native execution without another learning receipt. A session that never resumes may need operator
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
