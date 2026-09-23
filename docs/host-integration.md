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

`onEvent` is best effort and cannot gate persistence. Use required checkpoint hooks when a failed write must stop execution. The DSL provides hooks, not a durable scheduler or exactly-once delivery.

## Recovery and versions

Store the workflow digest together with interpreter, adapter and policy versions. The digest identifies the document, not the software or permissions used to run it. Preserve those versions and receipts for an active persisted run.

`executionPath` identifies nested child, branch, map-item and loop-iteration locations. A recovery host for newly composed structures must set `recovery.supportsExecutionPaths: true` and key stores by the full path. This declares host support; it does not implement storage. Reject structures your recovery implementation cannot resume.

Existing flat graphs retain their older effect keys. Repeated calls with the same label, transport and resolved input can reuse a memoized result, including across loop iterations. Use `call.poll` for repeated status checks and include an operation identifier for distinct effects. New composed graphs use path-scoped keys; this does not migrate old stores.

## Host policy around generative nodes

A host often has policy that is not part of the workflow language: a duty paragraph for the node that emits the terminal record, runtime metadata the model reports beside its record, an artifact field only the host can fill. `deps.hostPolicy` carries that policy as application code. Nothing in a workflow document can name or reach it, so a candidate workflow cannot change its host's channels.

| Hook | When | What the engine guarantees |
| --- | --- | --- |
| `systemBlocks(context)` | before a generative node runs | appended after the node's instructions; `context.terminal` is true for the node whose `out` is the workflow's output schema |
| `submissionSchema(stageSchema, context)` | before a generative node runs | the adapter submits against the returned schema; the raw submission is validated against it |
| `decodeSubmission(submission, context)` | after an accepted submission | returns `{ value, host? }`; `value` is validated against the unchanged stage schema and is what a `verify` clause reviews; `host` is merged into the reserved `$host` state key, so it is checkpointed and restored with the state, isolated per map item, branch and child like the state, excluded from a path-less output projection and returned as `result.host` |
| `afterNode(context)` | after any step, before commit and checkpoint | the returned patch is domain state: downstream nodes, recovery and output validation see it |

`context` names the workflow, the node (`kind`, `label`, `out`, `as`), the `executionPath`, the map `item` when inside a body, and for `decodeSubmission` the current `$host` so the host can accumulate (a list of concerns, for example). No workflow may name a `$`-prefixed state key: validation rejects such an `as`, and a code node or `afterNode` patch that writes `$host` fails with `reserved_state_key`. Parallel branches merge their `$host` deltas key by key: arrays append what each branch added, an unchanged value is kept, and two branches setting one non-array key to different values is a `parallel_write_conflict`. A map item's host state stays in the item's result state; a child workflow applies the same policy with its own context and its own `$host`, and only the child's validated output crosses back to the parent.

Keep the returned transport schema a superset of the stage schema. A decoder that drops a required domain field fails on the stage schema with `WorkflowOutputInvalidError`, and a review candidate that fails the transport schema is returned to the adapter as a rejection message so the same session can repair it.

## Adopt the document with another interpreter

`defineWorkflow` emits Workflow v2 JSON. Another interpreter can consume that document without importing this runtime, but a shared format number does not establish equivalent behavior.

Validate against the interpreter that will execute the document. Test its supported nodes, input and output contracts, assembled SOP instructions, cancellation and recovery. Keep the current interpreter available until those checks pass. Activate changed definitions as new candidates and retain old receipts if rollback or reconciliation is needed.
