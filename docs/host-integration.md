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

`context` names the workflow, the node (`kind`, `label`, `out`, `as`), the `executionPath`, the map `item` when inside a body, and for `decodeSubmission` the current `$host` so the host can accumulate (a list of concerns, for example). Validation rejects `$`-prefixed `as` keys and labels used as state keys by unaliased `agent`, `decide`, `extract`, and `code` nodes. Code patches may contain other `$`-prefixed keys, but a code node or `afterNode` patch that writes `$host` fails with `reserved_state_key`. Parallel branches merge their `$host` deltas key by key: arrays append what each branch added in declared branch order, an unchanged value is kept, and conflicting writes (including a scalar and an array at the same key) fail with `parallel_write_conflict`. A map item's host state stays in the item's result state; a child workflow applies the same policy with its own context and its own `$host`, and only the child's validated output crosses back to the parent.

Keep the returned transport schema a superset of the stage schema. A decoder that drops a required domain field fails on the stage schema with `WorkflowOutputInvalidError`, and a review candidate that fails the transport schema is returned to the adapter as a rejection message so the same session can repair it.

## Host addendum for authoring

Authoring has the same split as execution. The package owns the language: `authorContract()` renders it, `validateWorkflow` enforces it, and both read one vocabulary of node kinds, fields and predicates. A host supplies only what is its own through an `AuthorHostAddendum`. The package renders the addendum once, after the language, and never contains host vocabulary itself.

| Field | What the host declares | What the package does with it |
| --- | --- | --- |
| `name` | the host's name | the addendum's heading |
| `initialState` | the keys the host seeds into state, each with what it holds | tells the author the seed; `authorWorkflow` validates candidates against exactly these keys |
| `outputTypes` | its artifact types, each `prose` (the report writer under the host's name) or `file` (a produced file) | lists them; `candidatePolicyErrors` refuses any other artifact type; `applyHostOutputTypes` turns prose types into the report writer for validation, acceptance and execution |
| `nodeKinds` | the node kinds it runs | lists them; `candidatePolicyErrors` refuses any other kind |
| `rules` | host rules, one sentence each | renders them verbatim; the host enforces them in its acceptance callback or tool admission |

`authorWorkflow` returns the candidate as authored. A host with prose output types validates and runs `applyHostOutputTypes(workflow, host)` and keeps the authored bytes for its digest.

An addendum cannot change a language rule: it is appended after the language, which states that host rules add to it. Keep procedural knowledge a domain teaches in the host's expert data rather than in `rules`; the addendum is for what the host is, not what a domain learned. The Pi extension's addendum (`PI_HOST_ADDENDUM`) is a working example: its trusted-run command, its missing SOP text, and the transports it does not offer. A host registers the rendered contract, not the neutral skill: the Pi package builds `dist/skills/author` with the addendum appended to `SKILL.md` and its language reference, so a session reads the host rules without calling any tool. `describe` also returns the addendum as `authoring.host`. The package's own skill and its generated `language.md` stay host-neutral.

## Adopt the document with another interpreter

`defineWorkflow` emits Workflow v2 JSON. Another interpreter can consume that document without importing this runtime, but a shared format number does not establish equivalent behavior.

Validate against the interpreter that will execute the document. Test its supported nodes, input and output contracts, assembled SOP instructions, cancellation and recovery. Keep the current interpreter available until those checks pass. Activate changed definitions as new candidates and retain old receipts if rollback or reconciliation is needed.
