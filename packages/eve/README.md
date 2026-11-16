# AgentRun for eve

An additive extension for an existing [eve](https://github.com/vercel/eve) agent. eve keeps its
model, tools, credentials, permissions, channels and durable execution. AgentRun records each
turn and supplies independently checked notes and skills to later turns.

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
3. At settlement, read eve's committed session stream, including events whose individual hooks
   may have been missed. Upload visible assistant text, tool names/outcomes, model and reported usage.
   Raw tool inputs/results, reasoning and native credentials remain with eve.
4. Submit the original outcome once. AgentRun's ordinary runner reflects and independently checks
   proposals. A future fresh turn receives only accepted learning; submission alone is not promotion.

Opening AgentRun does not relocate the eve process or let AgentRun start arbitrary eve jobs. Run
and edit actions direct the coding agent back to the existing eve project.

## Boundaries and recovery

- This initial adapter learns from complete, fresh, text-only turns. Conversation follow-ups,
  steering, missing or referenced evidence, and child work are not claimed as complete learning
  evidence. Accepted learning can still be supplied; original task and policy remain authoritative.
- Notes and skills are reference text. This version does not install tools, rewrite the project,
  or bind executable learned workflows to eve's tools.
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
