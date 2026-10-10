# Integrate with your application

AgentRun executes a workflow through adapters supplied by your application. Start with the [support integration example](support-quickstart.md), which connects one search tool, Jev decisions and an existing agent.

| Interface | Application responsibility |
| --- | --- |
| `runEffect` | Dispatch permitted tools and validate their receipts. Own file access, external actions and idempotency storage. |
| `runNode` | Run an agent with the supplied instructions, projected input, output schema, tools and cancellation signal. Forward review feedback when the node permits draft repair. |
| `runJudge` | Answer the declared typed questions. The optional [Jev adapter](../packages/jev/README.md) implements this interface. |
| Lifecycle hooks | Store checkpoints and receipts, reconcile interrupted effects, and retain the runtime and adapter versions needed for recovery. |

Your application controls credentials, tools, budgets and delivery. An accepted model answer or completed workflow does not prove that an external action succeeded.

## Admit a workflow before running it

Use `inspectWorkflow` to read structure and required capabilities without running authored code. `validateWorkflow` can execute JavaScript probes. Code nodes run with process privileges, so untrusted authors require isolation supplied by your application.

Keep approval separate from the candidate document. A workflow cannot grant itself permission to use a tool or change its own acceptance checks. When nodes name SOP sections, supply the complete source text through `deps.sop`. Each decision must receive every section it depends on.

Root input schemas are checked before dispatch. Completed outputs must satisfy the declared output schema. Handle `escalated` results and thrown errors as separate outcomes; an escalation retains its reason and partial state.

## Cancellation and effects

Adapters receive a cancellation signal. Honor it in tool and model calls and bound their execution. An admitted effect may finish after cancellation; stopping the workflow does not undo it.

`EffectOutcomeUnknownError` retains a settlement promise for an effect still pending at cutoff. An `AggregateError` can contain several uncertain effects. Preserve those errors and reconcile their receipts before retrying. See the [effect and cancellation contracts](guide.md#limits).

`onEvent` is best effort and cannot gate persistence. JSON event data is a detached snapshot: observer mutations cannot change execution state or recovery records. Accessors are never evaluated while copying; unsafe non-JSON values remain invalid for required host trace validation rather than becoming valid data or disappearing. Use required checkpoint hooks when a failed write must stop execution. The DSL provides hooks, not a durable scheduler or exactly-once delivery.

## Recovery and versions

Store the workflow digest together with interpreter, adapter and policy versions. The digest identifies the document, not the software or permissions used to run it. Preserve those versions and receipts for an active persisted run.

`executionPath` identifies nested child, branch, map-item and loop-iteration locations. A recovery host for newly composed structures must set `recovery.supportsExecutionPaths: true` and key stores by the full path. This declares host support; it does not implement storage. Reject structures your recovery implementation cannot resume.

Existing flat graphs retain their older effect keys. Repeated calls with the same label, transport and resolved input can reuse a memoized result, including across loop iterations. Use `call.poll` for repeated status checks and include an operation identifier for distinct effects. New composed graphs use path-scoped keys; this does not migrate old stores.

## Durable recovery

> **Unreleased.** `@parcha/agentrun-dsl/recovery` and `@parcha/agentrun-pi/durable` are on the development branch and not in a published version. The hooks above are what the released package has.

`@parcha/agentrun-dsl/recovery` is a driver for the `recovery` hooks, so a host does not write a store protocol of its own. It loads only when imported.

```js
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, fileStore } from '@parcha/agentrun-dsl/recovery';

const driver = await openRecovery(fileStore(runDirectory), workflow, { key: runId, bind: { input } });
try {
  const result = await runWorkflow(workflow, input, withRecovery(driver, { runEffect, runNode, runJudge }));
} finally {
  await driver.close();
}
```

- **`openRecovery(store, workflow, { key, bind })`** opens the run's journal and takes ownership of it. `key` names the run: its step sessions and effect receipts are named under it, so the same key must be used in every process. `bind` is whatever else must not change between two opens of the run (the input, SOP text, the tool names): the run is bound to the workflow and to `bind`, and an open whose binding differs is refused with `RUN_STORE_BINDING_MISMATCH` naming the inputs that moved. Leave policy (trust, the model) out of `bind`, so a run resumes under a changed policy.
- **`withRecovery(driver, adapters, { durableNodes })`** returns the dependencies to run with. It supplies `recovery` and the driver's cancellation signal, and wraps three adapters: `runEffect` (each effect is admitted before it is dispatched, a completed one is answered from its receipt, and one admitted and never completed is refused), `runJudge` (a route's answer is committed before any branch step runs, and a resume follows it without asking again), and `runNode` (an agent step is committed before it runs and gets two attempts; the runner is handed its attempt as `step`). Set `durableNodes: true` only when your node runner keeps what each attempt delivered and answers a repeated `sessionId` from that record.
- **Run again with the same key, store and input** and every committed step is answered from the journal and every completed effect from its receipt, so no adapter is called for them.
- **`driver.stop({ action: 'pause' | 'cancel', source })`** stops the run through the driver's signal. A pause aborts an effect in flight.
- **Close the driver** in a `finally`. A journal has one owner at a time; a second open while the first is live is refused.

An effect that was admitted and never completed has an unknown outcome. It is never dispatched again: the next open fails with `FROZEN_EFFECT_UNKNOWN` naming it, until someone who knows what happened completes it in the store.

Put anything that counts requests (a call budget, a rate limit) inside `withRecovery`, around your own adapter, where it counts real dispatches. Outside, it also counts calls answered from receipts. Nothing outside `withRecovery` may retry a call: a second ask at the same path is a new effect and is dispatched.

Three stores keep the journal, all held to one conformance suite (`@parcha/agentrun-dsl/recovery/testing`):

| Store | Use |
| --- | --- |
| `memoryStore()` | Tests. Lost with the process. |
| `fileStore(directory)` | One host on one machine: one JSON file replaced by rename, and a lock owned by a process. |
| `documentStore(harness, key)` from `@parcha/agentrun-pi/durable` | A run on a pi-durable `Harness`, over its SQLite or disk storage. See the [pi package](../packages/pi/README.md#durable-workflows-on-pi-durable). |

The stored formats are fixed: a journal written by one build is read by the next.

## Host policy around generative nodes

A host often has policy that is not part of the workflow language: a duty paragraph for the node that emits the terminal record, runtime metadata the model reports beside its record, an artifact field only the host can fill. `deps.hostPolicy` carries that policy as application code. Nothing in a workflow document can name or reach it, so a candidate workflow cannot change its host's channels.

| Hook | When | What the engine guarantees |
| --- | --- | --- |
| `systemBlocks(context)` | before a generative node runs | appended after the node's instructions; `context.terminal` is true for the node whose `out` is the workflow's output schema |
| `submissionSchema(stageSchema, context)` | before a generative node runs | the adapter submits against the returned schema; the raw submission is validated against it |
| `decodeSubmission(submission, context)` | after an accepted submission | returns `{ value, host? }`; `value` is validated against the unchanged stage schema and is what a `verify` clause reviews; `host` is merged into the reserved `$host` state key, so it is checkpointed and restored with the state, isolated per map item, branch and child like the state, excluded from a path-less output projection and returned as `result.host` |
| `afterNode(context)` | after any step, before commit and checkpoint | the returned patch is domain state: downstream nodes, recovery and output validation see it |

`context` names the workflow, the node (`kind`, `label`, `out`, `as`), the `executionPath`, the map `item` when inside a body, and for `decodeSubmission` the current `$host` so the host can accumulate (a list of concerns, for example). Validation rejects `$`-prefixed `as` keys and labels used as state keys by unaliased `agent`, `decide`, `extract`, and `code` nodes. Code patches may contain other `$`-prefixed keys, but a code node or `afterNode` patch that writes `$host` fails with `reserved_state_key`. Parallel branches merge their `$host` deltas key by key: arrays append what each branch added in declared branch order, an unchanged value is kept, and conflicting writes (including a scalar and an array at the same key) fail with `parallel_write_conflict`. A map item's host state stays in the item's result state; a child workflow applies the same policy with its own context and its own `$host`, and only the child's validated output crosses back to the parent.

Keep the returned transport schema a superset of the stage schema. A decoder that drops a required domain field fails on the stage schema with `WorkflowOutputInvalidError`, and a review candidate that fails the transport schema is returned to the adapter as a rejection message so the same session can repair it.

## Host metadata on nodes

Every node accepts an optional `metadata` object. It belongs to the host: a place for the host's own markers on a node, such as the preset that generated it, that the host writes and reads back from the document. The engine treats it as opaque.

- Validation checks only that `metadata`, when present, is a plain object. A string, array, number, boolean or `null` is refused with an error naming the node. Keys and values are any JSON and are never inspected.
- The engine never reads it. Desugaring, `dryRunWorkflow`, `runWorkflow` and the author's candidate loop carry it through verbatim. It never enters state, events, prompts, judge requests or effect idempotency keys, so a run with metadata produces the same state and events as the same run without it.
- `workflowSha256` hashes the whole document, so metadata is part of the digest. Changing a marker changes the digest.
- Hooks that receive the node itself, such as `runEffect` and the recovery store, see it with its metadata.

The author contract tells authors to set only the metadata keys the host addendum names. A host that wants authors to write a key declares it in `metadataKeys`; without that field, authors set none. Enforce the keys in your acceptance callback, as with `rules`.

## Host addendum for authoring

Authoring has the same split as execution. The package owns the language: `authorContract()` renders it, `validateWorkflow` enforces it, and both read one vocabulary of node kinds, fields and predicates. A host supplies only what is its own through an `AuthorHostAddendum`. The package renders the addendum once, after the language, and never contains host vocabulary itself.

| Field | What the host declares | What the package does with it |
| --- | --- | --- |
| `name` | the host's name | the addendum's heading |
| `initialState` | the keys the host seeds into state, each with what it holds | tells the author the seed; `authorWorkflow` validates candidates against exactly these keys |
| `outputTypes` | its artifact types, each `prose` (the report writer under the host's name) or `file` (a produced file) | lists them; `candidatePolicyErrors` refuses any other artifact type; `applyHostOutputTypes` turns prose types into the report writer for validation, acceptance and execution |
| `nodeKinds` | the node kinds it runs | lists them; `candidatePolicyErrors` refuses any other kind |
| `rules` | host rules, one sentence each | renders them verbatim; the host enforces them in its acceptance callback or tool admission |
| `metadataKeys` | the node `metadata` keys an author may set, each with what it holds | lists them; without it the contract tells authors to set no metadata; the host enforces the keys in its acceptance callback |

`authorWorkflow` returns the candidate as authored. A host with prose output types validates and runs `applyHostOutputTypes(workflow, host)` and keeps the authored bytes for its digest.

An addendum cannot change a language rule: it is appended after the language, which states that host rules add to it. Keep procedural knowledge a domain teaches in the host's expert data rather than in `rules`; the addendum is for what the host is, not what a domain learned. The Pi extension's addendum (`PI_HOST_ADDENDUM`) is a working example: its trusted-run command, its missing SOP text, and the transports it does not offer. A host registers the rendered contract, not the neutral skill: the Pi package builds `dist/skills/author` with the addendum appended to `SKILL.md` and its language reference, so a session reads the host rules without calling any tool. `describe` also returns the addendum as `authoring.host`. The package's own skill and its generated `language.md` stay host-neutral.

## Adopt the document with another interpreter

`defineWorkflow` emits Workflow v2 JSON. Another interpreter can consume that document without importing this runtime, but a shared format number does not establish equivalent behavior.

Validate against the interpreter that will execute the document. Test its supported nodes, input and output contracts, assembled SOP instructions, cancellation and recovery. Keep the current interpreter available until those checks pass. Activate changed definitions as new candidates and retain old receipts if rollback or reconciliation is needed.

### Host preparation of observations

A host with required trace validation can supply synchronous `prepareEvent(event)`.
It receives the event before generic copying, must not mutate it, and must return a
detached snapshot for `onEvent`, or `undefined` to omit a rejected event. Preparation
and observer exceptions cannot replace execution failures or interrupt recovery cleanup.
For required trace validation, the host aborts its supplied signal before omitting the
event. Cancellation stops subsequent work while preserving uncertain-effect handles and
partial-result persistence. This is a trusted host boundary, not a user callback or a
sandbox. Without it the interpreter detaches JSON values and preserves unsafe non-JSON
shapes for host validation.

Pi uses this boundary to enforce its existing per-event byte, depth and value limits
before copying a full oversized event. The generic DSL adds no payload or resource
limit. Scoped location and child-label forwarding preserve the observation boundary,
so one event is prepared once regardless of graph nesting.
