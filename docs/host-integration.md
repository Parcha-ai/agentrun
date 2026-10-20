# Integrate with your application

AgentRun executes a workflow through adapters supplied by your application. Start with the [support integration example](support-quickstart.md), which connects one search tool, Jev decisions and an existing agent.

| Interface | Application responsibility |
| --- | --- |
| `runEffect` | Dispatch permitted tools and validate their receipts. Own file access, external actions and idempotency storage. |
| `runNode` | Run an agent with the supplied instructions, projected input, output schema, tools and cancellation signal. Forward review feedback when the node permits draft repair. |
| `runJudge` | Answer the declared typed questions. The optional [Jev adapter](../packages/jev/README.md) implements this interface. |
| Lifecycle hooks | Store checkpoints and receipts, reconcile interrupted effects, and retain the runtime and adapter versions needed for recovery. |

For a durable pi host that also runs a browser and vision, see [what a host supplies](reference-host.md) and its runnable example.

Your application controls credentials, tools, budgets and delivery. An accepted model answer or completed workflow does not prove that an external action succeeded.

## Admit a workflow before running it

Use `inspectWorkflow` to read structure and required capabilities without running authored code. `validateWorkflow` can execute JavaScript probes. Code nodes run with process privileges, so untrusted authors require isolation supplied by your application.

Keep approval separate from the candidate document. A workflow cannot grant itself permission to use a tool or change its own acceptance checks. When nodes name SOP sections, supply the complete source text through `deps.sop`. Each decision must receive every section it depends on.

Root input schemas are checked before dispatch. Completed outputs must satisfy the declared output schema. Handle `escalated` results and thrown errors as separate outcomes; an escalation retains its reason and partial state.

## Cancellation and effects

Adapters receive a cancellation signal. Honor it in tool and model calls and bound their execution. An admitted effect may finish after cancellation; stopping the workflow does not undo it.

`EffectOutcomeUnknownError` retains a settlement promise for an effect still pending at cutoff. An `AggregateError` can contain several uncertain effects. Preserve those errors and reconcile their receipts before retrying. See the [effect and cancellation contracts](guide.md#contracts-and-limits).

`onEvent` is best effort and cannot gate persistence. JSON event data is a detached snapshot: observer mutations cannot change execution state or recovery records. Accessors are never evaluated while copying; unsafe non-JSON values remain invalid for required host trace validation rather than becoming valid data or disappearing. Use required checkpoint hooks when a failed write must stop execution. The DSL provides hooks, not a durable scheduler or exactly-once delivery.

## Recovery and versions

Store the workflow digest together with interpreter, adapter and policy versions. The digest identifies the document, not the software or permissions used to run it. Preserve those versions and receipts for an active persisted run.

`executionPath` identifies nested child, branch, map-item and loop-iteration locations. A recovery host for newly composed structures must set `recovery.supportsExecutionPaths: true` and key stores by the full path. This declares host support; it does not implement storage. Reject structures your recovery implementation cannot resume.

Existing flat graphs retain their older effect keys. Repeated calls with the same label, transport and resolved input can reuse a memoized result, including across loop iterations. Use `call.poll` for repeated status checks and include an operation identifier for distinct effects. New composed graphs use path-scoped keys; this does not migrate old stores.

`@parcha/agentrun-pi/durable` runs on pi-durable and chord 1.0.4 to 1.3.x with one build; CI runs it on 1.0.4, 1.1.0, 1.2.0 and 1.3.0. A store moves forward with pi, not back:

- A run that a pi-durable 1.1 process started and left (killed with a tool call in flight, mid-submit, or paused) is resumed by a 1.2 process and completes, with no effect dispatched twice. pi 1.2 migrates the call's `pi.tool` task to version 2. This package's own documents keep their kinds and versions, and their stored rows are the same on both.
- A run that pi 1.2 left with a tool call in flight cannot be continued by pi 1.1. pi 1.2 keeps that call as a version 2 `pi.tool` task; a 1.1 process waits on it and does not end the run. The only thing it writes is that task's mark from running back to pending, as pi does for any task a dead process left running. A later 1.2 process continues the run, and makes no request twice. Continue such a run on 1.2, and do not downgrade pi under a live run. To fail fast instead of waiting, call `refuseNewerTasks(harness, context)` from `@parcha/agentrun-pi/durable` after `Harness.open` and before `resume()`. On pi before 1.2 it throws `NewerTaskError` (code `PI_TASK_NEWER`) for a live `pi.tool` task above version 1; on 1.2 it does nothing.

### The agentrun tool in a pi-durable session

`createWorkflowTool(host)` from `@parcha/agentrun-pi/durable` gives an agent in a pi-durable session the agentrun tool. Its actions are the coding-agent extension's, run by the same code:

- `describe`: the host's tools and the language.
- `inspect`: validates a complete workflow and keeps it as the conversation's draft, a session document.
- `dry-run`: runs the draft on synthetic values, with no model, Jev or tool call, and answers `passed`, `not_run` or `failed`.
- `save`, `load` and `list`: the project store of `@parcha/agentrun-pi/workflows` under `host.projectDir`.
- `run`: described below.

```ts
const { extension, workflow } = createWorkflowTool({ projectDir, tools, task: { options, run }, runCode });
registry.install(extension); // and list the tool's name, `agentrun`, in the agent definition
```

- `run` starts the draft as one `agentrun.workflow` task of the calling conversation, in the background. The tool's own commit creates the task, so no Harness is needed. The call waits for the task and answers with its outcome and the run's last progress lines. While the run goes on, the progress lines the coding-agent extension shows are written to the call's running output. A run of the same draft on the same input in the same conversation is the same run: a call after a restart waits for the live task, and a call after it ended answers with its outcome, so its effects happen once. `again: true` starts a fresh run of them. How many fresh runs were asked for is a session document (`agentrun.runs`), so a later `run`, after a restart too, reaches the newest.
- `tools` are the tools a drafted workflow may use, as a call's tool and as an agent node's tools (`read`, `grep` and the like included): the host decides, and nothing else is admitted. Inspect refuses a workflow that uses any other, naming each and pointing at `createWorkflowTool`'s `tools`.
- Give each tool a workflow calls a `resultSchema`, the JSON Schema of what your `runEffect` returns for it. `describe` gives it to the authoring agent as the call's result contract, so the call's `out` declares those fields and the next node reads them typed. Without one, `describe` reports pi's result envelope (`{ content, details }`, `details` undeclared) and tells the agent not to invent fields inside it, so the result reaches the next node untyped. The run checks each call's result against its `out`.
- List every extension the agent's conversation needs in the root agent's extensions, including agentLearn and the workflow tool; installing in the registry alone is not enough. For example, with `const learn = agentLearn({ guard, secrets })` (it returns the extension itself), `harness.root(context, { agent: { model, extensions: [learn, workflowTool.extension] } })` offers the tools of both, and with only `[workflowTool.extension]` the conversation is offered `agentrun` alone.
- `task` is `createWorkflowExtension`'s host, so the run has the same driver, journal, stops and ladder as a run the host starts itself. `workflow.read` and `workflow.stop` reach it from the host's side.
- Code nodes run only through `host.runCode`. Without it, a dry run of a workflow with code is `not_run`, and a run of one is refused before it starts.
- `createWorkflowExtension`'s `start` and `read` take a tool's `api` as well as a Harness (`WorkflowCaller`). A caller with no root conversation names the conversation in `options.conversationId`. A start with a cancel needs a Harness.

## Decision receipts

Every typed question (`judge`, `pick`, `sift`, `route`, an `ask` predicate, a `verify` review) is one decision. Supply `recordDecision(receipt, exchange)` to keep them:

- It is awaited before the answers reach state, an event or a branch. If it rejects, the node fails with `WorkflowDecisionRecordError` and nothing acted on the answers.
- A `DecisionReceipt` holds the questions, the answers as they came back, the `rule` that turns them into an `action` (every threshold included) and the action. `rederiveDecision(receipt)` recomputes the action from the receipt alone, so a stored decision can be explained, or evaluated under another threshold, without a model call.
- `receipt.id` is the request's identity: its execution path, kind and position among its node's requests, with the questions and a hash of the state it asked about. The same request asked again has the same id. The decision events (`judge.answered`, `route.chosen`, `ask.evaluated`, `verify.answered`) carry it as `decision_id`; a sift's `judge.answered` carries `decision_ids`, one per request. `runJudge` receives it as `decisionId`.
- `status` is `answered`, `failed` (the judge rejected, or its answers were refused; what came back is kept) or `cancelled` (the request's signal was aborted before it settled, so whether it was served is not known). A request is recorded in every case, before its failure is thrown.
- A sift over `maxQuestionsPerRequest` or `maxStateBytesPerRequest` sends several requests and records one receipt for each. `request.items` lists the positions in the sifted list a request covers, and its action names kept items by their position in that request. When one request fails, the requests still in flight are cancelled and recorded as `cancelled`, a request that had already answered keeps its `answered` receipt, and no event names any of them: the sift decided nothing.
- `exchange.request` is the request as `runJudge` received it, and `exchange.result` is the object `runJudge` returned, so a host reads back anything of its own it put there.

To make decisions durable across a restart, also supply `recovery.decision(id)`. When it returns an `answered` receipt, its answers are used and the judge is not asked again: a resumed run decides what the interrupted run decided, including a loop's `until: ask` and a route whose branch had already started. Such a decision is not recorded again and its event carries `replayed: true`. Any other receipt, or none, means the request is asked. A receipt is evidence of what was decided, not of what was committed: the node's commit is still `recovery.commit`.

A pi-durable host keeps a run's typed-question decisions as rows of the session document `agentrun.decisions`, from `@parcha/agentrun-pi/durable`. `createDecisionWriter({ open })` commits rows in the order they are recorded and opens the run's Session only when the first row needs it. `settled()` reports the first commit that failed and keeps the Session; `flush()` also commits any row recorded while it runs, releases every Session the writer opened, then reports the first failed commit (or, when none failed, a failed release). `readDecisions(read)` returns the rows in commit order from a Session or a Harness. A row (`DecisionRow`, version 1) is a stored format and does not change with the interpreter: the host fills it, including the request's size and metering, which the interpreter does not know.

Inside a workflow task (`createWorkflowExtension`), `decisionRecovery(invocation)` gives both hooks over the task's own commit, from the invocation the host's `run` is handed. `recordDecision` commits each receipt as a row, in the order receipts are recorded, and resolves once that row is durable; the task's state is untouched. `decision(id)` rebuilds the receipt from the last answered row this run recorded under `id`. A row it writes also carries the receipt's `decision_id`, its `request` position, its `state_sha256` and the run's key (`run_key`), so the row is the whole receipt again for that run. Every run in a Session shares the rows' document and a receipt's id does not name its run, so another run's row never answers, and neither does a row without these fields. Wire them in the host's `run`:

```ts
run: (invocation) => {
  const decisions = decisionRecovery(invocation);
  const deps = withRecovery(invocation.driver, { runJudge, recordDecision: decisions.recordDecision });
  return { deps: { ...deps, recovery: { ...deps.recovery!, decision: decisions.decision } } };
},
```

A run's store can be recorded for a viewer as durable lines (`agentrun.recording/1`): one line per document revision, conversation entry and task record, with the store's commit and the line's order inside it. A disk run's store admits one connection, so the recorder runs inside each of the run's processes: after the run is opened and before it resumes, write `snapshotLines(storage, { at, context })` (every document as it stands, `at` the store's latest commit), then `recordCommits(harness, { from: snapshot, write })`, which writes each later commit's lines as pi adopts it. `from` carries the snapshot's generation and its node attempts' conversations into the recorder, so a node the run resumes keeps its path on the records of its conversation. `recordingLines(file)` reads a store no process holds; it sees only the revisions pi kept, since pi deletes a current-only document's older revisions when it writes a new base.

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

`authorWorkflow` returns the candidate as authored. A host with prose output types validates and runs `applyHostOutputTypes(workflow, host)` and keeps the authored bytes for its digest. A host that accepts other spellings of its type names passes `{ normalizeType }`, a function from an authored type to one of `host.outputTypes` (or null): `applyHostOutputTypes(workflow, host, { normalizeType })`. Without it a type is matched exactly.

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
