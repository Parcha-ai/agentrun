# Build with agent.run()

AgentRun defines workflows that combine tools, code, Jev system one decisions, and agents. Models return typed results; code checks schemas and controls execution.

<a id="quickstart"></a>
## Start with an example

Use Node 22.19+ and npm. Follow the [support example](../README.md#run-the-support-example) to install, build and run the support example without credentials. It searches for an answer, checks it, and calls an agent only when investigation is needed. [Connect your own tools and models](support-quickstart.md) after the scripted example works.

For TypeScript authoring and reusable child workflows, follow the [research tutorial](authoring.md). The [standalone starter](../examples/starter/README.md) runs outside this checkout. See [all examples](examples.md) for their commands and failure paths. To watch an agent read and look at files, start at [`examples/vision-agent`](../examples/vision-agent/README.md): `npm run demo:vision -- examples/document-check` runs it on scripted models, free and with no key, with `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path. `lake-mead` commits its images too; the six other vision examples fetch their files first (120 MB to 342 MB): add `--fetch-sources`.

## Inspect the smaller triage workflow

In your project, install the core and save the complete triage workflow:

```sh
npm install @parcha/agentrun-dsl@beta
npx agentrun example workflow.json
npx agentrun validate workflow.json --trusted
npx agentrun dry-run workflow.json --trusted
```

`example` refuses to overwrite a file. `--trusted` acknowledges that JavaScript in a workflow may execute during validation. Dry-run synthesizes the declared input schema; a workflow without one starts from `{}`. Supply your own JSON object when needed:

```sh
npx agentrun validate workflow.json input.json --trusted
npx agentrun dry-run workflow.json input.json --trusted
```

Structural checks, including unknown node fields, always run. Supplied inputs also check the input schema and reachable input keys. Dry-run checks synthetic execution wiring, not model quality or effect delivery. Its `status` says whether every check ran: `passed`, `failed` (`ok` is false, `problems` say why), or `not_run`: `ok` stays true, but a path could not be exercised (for example, a synthetic judgment escalated or a schema cannot be synthesized), and `skipped` gives the reasons. A `not_run` result is not execution proof. `agentrun dry-run` exits 1 on a failure and 0 otherwise; with `--strict` it exits 3 when the status is `not_run`.

### Read validation errors

A rejected workflow comes back as `{ ok: false, errors, issues }`. `errors` are the messages, and `issues` carries one `{ path, code, message }` per message, in the same order, with `message` the same text. `path` is a JSON Pointer (RFC 6901) into the workflow as written, naming what the rule is about: a node (`/root/steps/1`, `/root/branches/yes/body`, `/root/steps/2/workflow/root/steps/0` inside a child), the same path `inspectWorkflow` gives that node; a schema (`/schemas/Result`); a value the shape check refused; or `""` for the document's own fields and for an input supplied to validation. It never names a key that is missing: a missing field points at the node that should hold it. `WorkflowInvalidError` carries the same `issues`.

`code` names the rule. The set is closed: a new code may be added later, so keep a default branch; a code is never renamed.

| Code | The rule | Example message (its start) |
|---|---|---|
| `DOCUMENT_INVALID` | The document is plain JSON data within size and depth bounds | `workflow document contains a cycle` |
| `SHAPE_INVALID` | A field has the wrong JSON type | `workflow.root.steps[0].instructions must be a string` |
| `WORKFLOW_FIELD_INVALID` | `v`, `name`, `schemas`, `input` and `output` (a child's too) | `workflow.v must be 2` |
| `SCHEMA_INVALID` | A schema is an object, its `$ref`s resolve, it compiles, and a question schema is one | `schema "B": unsupported $ref form "https://example.com/x"` |
| `SCHEMA_UNKNOWN` | A node's `out` names a schema in `schemas` | `root.steps[1] (b): out schema "Nope" not in workflow.schemas` |
| `INPUT_INVALID` | The input supplied to validation fits the input schema | `input: #: must have required properties doc` |
| `NODE_KIND_UNKNOWN` | A node is one of the kinds (a missing body is none) | `root.steps[1]: unknown node kind "teleport"` |
| `NODE_KEY_UNKNOWN` | A node holds only its kind's keys, and none of another form's (another `via`, a file artifact, the other route form) | `root.steps[0] (a): unknown key(s) for a agent node: colour` |
| `NODE_FIELD_INVALID` | A node's required field is present and each field has an allowed value | `root.steps[1] (l): maxIters must be an integer >= 1` |
| `STATE_KEY_RESERVED` | No node writes an engine-owned `$` key or the reserved host key | `root.steps[0] (a): "as" must not name an engine-owned "$" state key ("$mine")` |
| `STATE_PATH_UNPRODUCED` | A read, interpolation, `requires`, `itemsPath`, `valuePath`, `output.path` or file names something an input key or an earlier node produces | `root.steps[0] (a): requires "nowhere" but no upstream node produces it` |
| `STATE_PATH_EXCLUDED` | A path fits the shape its producer declares | `root.steps[0] (a) requires: state path "doc.b" is excluded by the upstream schema at "doc"` |
| `PARALLEL_WRITE_CONFLICT` | Parallel branches write disjoint keys | `root.steps[0] (p): branches 0 and 1 both write state.x` |
| `STRUCTURE_INVALID` | Branch and step counts, and where a report or artifact may stand | `root.steps[0] (p): parallel needs at least two branches` |
| `PREDICATE_INVALID` | A predicate is a known one with its fields | `root.steps[1] (e): when: unknown predicate "phase_of_moon"` |
| `CODE_INVALID` | Code compiles, keeps to its sandbox's rules, and does not throw on reference data | `root.steps[0] (c): code transform failed to compile: Unexpected token 'return'` |

## Use a deterministic workflow

After installing the core above, save this as `double.mjs` in your project and run `node double.mjs`.

```js
import { runWorkflow } from '@parcha/agentrun-dsl';

const workflow = {
  v: 2,
  name: 'double',
  schemas: {
    Input: {
      type: 'object', properties: { value: { type: 'number' } },
      required: ['value'], additionalProperties: false,
    },
    Result: {
      type: 'object', properties: { value: { type: 'number' } },
      required: ['value'], additionalProperties: false,
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: {
    node: 'code', label: 'double',
    code: 's => ({ result: { value: s.value * 2 } })',
  },
};
const result = await runWorkflow(workflow, { value: 21 }, {});
console.log(result.output); // { value: 42 }
```

The `input` contract, when supplied, is checked before execution. A completed workflow must satisfy its final output contract. An escalation returns early with its reason and current state instead of a completed output. The runtime returns `complete` or `escalated`; validation, adapter, verification, and execution failures reject the promise. Handle errors as well as the two result states. The deterministic example should print `{ value: 42 }`.

<a id="jev"></a>
## Add live Jev system one decisions

Jev is the optional TypeSafe model adapter for typed judgments. This section makes a live model request, unlike the offline demo. Install `@parcha/agentrun-jev@beta` alongside the core and obtain authorized TypeSafe access through your provider or organization. Configure `TYPESAFE_API_KEY` in the server environment using your existing secret-management process. If your organization uses a gateway, also use its configured `TYPESAFE_BASE_URL`. Do not put credentials in browser code or commit them to this source tree.

In your project after configuring access, save this as `live-triage.mjs` and run `node live-triage.mjs`. A live model can return a different answer from the scripted fixture:

```js
import { runTriageDemo } from '@parcha/agentrun-dsl/demo';
import { createJevRunner } from '@parcha/agentrun-jev';

const runJudge = createJevRunner({
  timeoutMs: 30_000,
  maxAttempts: 3,
});
const demo = await runTriageDemo('billing', runJudge);
console.log(demo.result);
```

`TYPESAFE_BASE_URL` or `baseURL` can select a configured gateway. The adapter uses the official TypeSafe SDK, bounds retries and total duration, and retains raw answers, reported usage, and the request hash. Cost is `null` unless explicit pricing and usage are both available. Reported estimates do not include unknown failed-attempt costs.

A `judge` schema is a flat object. Boolean properties become Noul questions (a probability from 0 to 1 that the answer is yes), string enums become Choice questions, and appropriately declared integer levels become Score questions. Descriptions carry the questions; criteria carry the meaning of choices. The typed result lands at `as`, and the raw answers and confidence at `<as>$answers`.

Confidence is a model output, not an empirically calibrated accuracy guarantee. The demo's 70% threshold is illustrative. Test thresholds on your own fixed cases before using them for consequential decisions.

<a id="pi"></a>
## Let Pi build and run a workflow

With [Pi 1.1.0 installed](../packages/pi/README.md#install), run these commands in your project:

```sh
pi install npm:@parcha/agentrun-pi@beta -l
pi --offline
```

`-l` installs in this project. `--offline` skips startup downloads, not intentional model calls. Pi asks whether you trust the project before loading its extension on first launch.

Inside Pi, run `/agentrun demo` to see a scripted research workflow without making model calls. Run `/agentrun status` to confirm that the authoring skill loaded. If Pi 1.1.0 is already open, use `/reload` first. The npm package includes the extension and skill; no AgentRun checkout is needed.

With model access configured in Pi, describe a task:

```text
/agentrun Research how this repository handles cancellation. Investigate the runtime and tests separately, then report the gaps with file references.
```

The packaged skill has Pi inspect the available tools and build a workflow using the selected Pi model. `/agentrun` opens the graph; `/agentrun run` executes it; `/agentrun stop` requests cancellation. Use `/agentrun save` and `/agentrun load` for project-local named definition saves. Saves do not retain input or execution permission. Jev access is needed only for system one decisions. See [Pi setup and limits](../packages/pi/README.md).

### Embed the Pi SDK

Use `createPiHostRunner` inside an existing Pi extension or `createPiRunner` with a configured standalone SDK runtime. Supply tools explicitly. The runner forwards schema and review feedback to the same agent session, bounds turns and submissions, and honors cancellation.

For authoring, `authorWorkflow` from `@parcha/agentrun-dsl` retains a candidate and its feedback without activating it. Pass it a Pi runner as its `runNode`. Supply your own acceptance callback to evaluate behavior. Without that callback, acceptance checks structure only.

For an authoritative SOP, supply complete `rubricSections` during authoring and the same source text through runtime `sop`. The author conservatively requires every generative node to carry all supplied sections and rejects semantic paths that cannot carry them. See [Pi SDK setup](../packages/pi/README.md#sdk-embed-the-runner) for configuration and limits.

<a id="primitives"></a>
## The primitives

| Primitive | What it does |
| --- | --- |
| `chain` | Run steps in order. |
| `map` | Run a body for each item, with bounded concurrency. |
| `parallel` | Run independent branches; conflicting state writes are errors. |
| `loop` | Repeat until a predicate holds, with a fixed iteration bound. |
| `judge` | Ask a flat set of typed questions. |
| `pick` | Choose one item, optionally none, retaining the distribution. |
| `sift` | Ask questions about a collection and retain selected items. |
| `route` | Run one of several branches. Jev chooses by meaning, with an explicit uncertain fallback, or a `valuePath` names a branch the workflow already decided, with no model call. |
| `agent`, `decide`, `extract` | Obtain a schema-checked result from an agent adapter. |
| `code` | Apply a trusted JavaScript state transformation. |
| `call` | Delegate a bounded tool, executor, or shell effect to the host. |
| `workflow` | Invoke an isolated child with explicit input/output contracts. Children can compose maps, loops, routes, parallel branches and children; terminal reports/artifacts stay with the parent. |
| `escalate` | Stop with the reason and current state for the host to handle. |
| `report`, `artifact` | Declare terminal prose or file metadata; the host owns delivery. |

Start with `chain`, `agent`/`extract`, `judge`, `code`, and `escalate`. Add collection and concurrency nodes when the workflow needs them. `report`, `artifact`, shell/executor transports, recovery and slices are advanced host integration; the host implements tools, delivery and storage.

### Jev, code, or route by value

Ask Jev what needs judgment: whether an answer resolves a request, whether two records describe the same thing, which category a ticket belongs to. Compute in code what is certain from the data: lookups, arithmetic, exact matches, and the threshold you apply to Jev's probabilities. Once a decision is in state, route by it instead of asking again:

```js
{ node: 'judge', label: 'classify', state: { ticket: '{ticket}' }, out: 'Kind', as: 'kind' },
{ node: 'code', label: 'policy', code: `s => ({ action:
    s['kind$answers'].confidence.kind >= 0.9 ? s.kind.kind : 'clarify' })` },
{ node: 'route', label: 'act', valuePath: 'action', otherwise: 'clarify',
  branches: { refund: { body: refundSteps }, bug: { body: bugSteps },
              question: { body: docSteps }, clarify: { body: followUp } } }
```

The route asks nothing. It runs the branch the string at `valuePath` names:
- A missing value or an unknown name takes `otherwise`. Without `otherwise`, the route fails before any branch runs.
- A number, boolean or object is never treated as a branch name.
- `as` records `{value, taken, fallback}`.

A second `route` with `instructions` would cost another request, and it could choose differently from the judge, past your threshold. Use the Jev form of `route` when the choice itself is the judgment and nothing has decided it yet.

### State, instructions and collection results

LLM `instructions` are literal text. Write "Read text from the JSON input." State arrives separately as the adapter's JSON user message. Optional `state` maps let an LLM node see only selected values:

```json
{ "node": "extract", "label": "count", "instructions": "Read text from the JSON input.", "state": { "text": "{ticket}" }, "out": "Count", "as": "result" }
```

Without `state`, the node receives accumulated state, with legacy `context.references` and `context.references_parsed` omitted. Explicit state maps have no implicit reference filtering. Use them to control prompt size and which data each model sees.

| Field | Placeholder behavior |
| --- | --- |
| Node/verification/question `state`, child `input`, effect `args`/`input`/`env` | `{ticket}` reads state; a whole placeholder preserves type; missing paths throw. |
| `pick.describe`, `sift.describe`, `escalate.summary` | Text rendering; missing paths appear as `(path unset)`. Item descriptions also see `item` and `item_index`. |
| LLM or question `instructions`, shell `command`, executor `code` | Literal text/source; no placeholder substitution. |

Use `map.resultPath` to select one value from each completed item state, including when the body is a chain. For example, `resultPath: "result"` collects only that item's result. A missing path rejects the map. Without it, a body's `as` selects its result; otherwise the complete item state is retained for compatibility, which can duplicate parent data across items.

By default (`onItemFailure: "stop"`) the first item that fails stops the map and the run. With `onItemFailure: "collect"` and `failedAs: "failed"`, an item that ends on an item failure becomes a row `{item_index, label, code, message}` of `failed`, in item order, and the other items finish. `as` stays aligned with the items: `as[i]` is item i's result, or `null` when item i failed, so a later node reads item i at i and filters the nulls itself when it wants only the successes. The map never escalates by itself; gate on `failed` with `escalate` (`count_gte`) or a code node. An item failure is one of the interpreter's own typed node failures (an `EffectFailure` after its retries, `WorkflowOutputInvalidError`, `WorkflowStateError`, `WorkflowCodeError`, `WorkflowVerificationError`) or a host error that declares itself one with a string `code` and `itemFailure: true`; `isItemFailure(error)` is the rule. An effect whose outcome is unknown, a recovery failure, an `escalate` inside the item, a stop or cancel, and anything else stop the map as before. Each collected row emits `map.item_failed`. When several branches of a parallel, or items of a map that stops, fail at once, an item failure is reported only when every other failure is one too, so it never hides a failure the map must stop on.

Mechanical predicates compare actual values; `ask` delegates a semantic question to `runJudge`. The generated `@parcha/agentrun-dsl/schema` assists editors; runtime validation also checks graph and semantic constraints.

## Verify a returned candidate

A generative node can declare `verify: {out: 'Checks', maxDrives: 3}`. `Checks` is a judgment schema. The engine exposes a `review` callback so an adapter can repair a rejected submission within the same session. The engine also verifies the returned candidate even if the adapter ignores that callback. A rejected final submission or exhausted review budget throws `WorkflowVerificationError` with the candidate and raw judgment evidence; an exhausted verification is never silently accepted.

Verification questions assess the evidence given to them. They are not an independent fact source. Keep acceptance fixtures, rubric text, and thresholds host-owned so a generated workflow cannot change its own test to pass.

<a id="limits"></a>
## Contracts and limits

- **Trusted execution.** JavaScript runs in the process. Validation can execute probes. Run unknown workflows in a host-controlled isolation boundary.
- **State ownership.** Input and seeded state must be structured-cloneable. The runtime copies caller input and each map item or parallel branch. Parallel branches that change the same top-level field conflict, including nested mutations; unchanged copies are not writes.
- **Admission.** Required adapters and all named SOP sections are checked before any node runs, including untaken branches and child workflows. Invalid input contracts are reported as `WorkflowInputInvalidError`.
- **Cancellation.** Core adapters receive signals; effect deadlines and caller cancellation bound the core's wait for an injected effect, while Pi and Jev bound their own callers. An uncooperative tool can continue its effect after cancellation. Synchronous JavaScript can block the process. There is no general hard-kill sandbox here.
- **Effects.** The host implements `runEffect`, enforces tools and file access, verifies promised files, and handles custody. Idempotency keys help a host deduplicate; they do not confer exactly-once delivery. Inspect uncertain outcomes before retrying. An admitted effect still pending at cutoff throws `EffectOutcomeUnknownError` (`effect_outcome_unknown`) and is never retried automatically. Its `settlement` promise retains any eventual fulfillment or rejection, and `effect.late_settled` reports that evidence to the host. Late settled results are not memoized, committed, or delivered. A result already known to be late throws `EffectDeadlineExceededError` with `lateResult`. Concurrent failures can return an `AggregateError`; inspect its `errors` recursively for every uncertain effect, with the original failure retained as `cause`.
- **Escalation in collections.** Pure map escalation emits `map.escalated`, keeps the triggering item's local state, and does not call the failure persistence hook. Completed sibling state is not promoted as a completed map. If cancellation leaves uncertain effects, the run rejects with an `AggregateError`; inspect its `errors` and `cause` for public `EscalationSignal` and `EffectOutcomeUnknownError` instances. Reconcile effects before retrying. No escalation evidence is discarded.
- **Failures in collections.** Under recovery a collected failure is committed with its item before the map goes on, and every later process ends the item on it without running its body; a store without `recovery.failItem` and `recovery.itemFailure` cannot hold such a map, and it is refused before any step runs. An item whose call the driver left with an unknown outcome is refused as `FROZEN_EFFECT_UNKNOWN`, never collected. A failed item's spend still counts. Run a collecting workflow only once every process that can open the run is on a release that knows `onItemFailure`: an earlier release refuses the workflow at its open, which fails its task and ends the agent nodes in flight, and they start again in new conversations at the cost of those turns (in the reference kill storm, 4.27 to 4.30 model requests per committed turn with old processes against 3.04 and 3.40 without (the medians of four 50-seed storms), about 33% more).
- **Loop exits.** `loop.exited` reports `condition_met` or `bound_reached` and the iteration count. Reaching the bound keeps the current state; use a following gate if it should escalate.
- **Recovery.** Checkpoint, memo, and recovery interfaces are host hooks, not a bundled durable scheduler. In legacy graphs, repeated calls with the same label, transport and resolved input share an idempotency key, including across loop iterations. A memo hit reuses the earlier result. Use `call.poll` for repeated status checks; for distinct operations, include an operation identifier in the call input. Newly composed child graphs require `recovery.supportsExecutionPaths: true` and stores keyed by the full execution path; see [host integration](host-integration.md). Required checkpoint writes can stop execution. A durable receipt may be read after poll expiry within the node deadline; the host must reject any fresh admission after the original poll deadline. A completed run alone does not prove file delivery.
- **Observability.** `onEvent` is best effort and is not awaited; thrown errors and rejected promises from observers cannot change a workflow outcome. Use required checkpoint hooks to gate persistence. `onEvent` reports runtime events. Raw state, answers, candidate files, and error evidence may contain application data; the host controls storage, access, retention, and redaction.
- **Versioning.** The author creates new candidate files in unique directories and refuses to overwrite an existing draft. The filesystem remains host-controlled; this is not tamper-proof storage. Activation, rollback, ownership, budgets, and cross-agent coordination remain outside the core. This beta's API may change.

### Numeric limits

These are engine rules, not provider capacity guarantees. The numeric knobs below carry no upper ceiling — the author picks the number and a host may set a default, but the validator never caps how high it goes. What the validator keeps are lower bounds (a floor a value must sit at or above), structural requirements (a field that must be present), the System-One question shape (a bounded multiple choice), and the parser's own safety guards. Hosts can still impose tighter budgets as defaults.

| Setting | Bound / default |
| --- | --- |
| `loop.maxIters` | Integer >= 1, required |
| `map.maxConcurrency` | Positive safe integer; default 4 |
| `map.onItemFailure` | `stop` (default) or `collect`; `failedAs` is required with `collect`, refused without it, and differs from `as` |
| `call.deadline_s` | Required; finite, greater than 0 seconds |
| `call.retry.attempts` | Integer >= 1 when retry is declared |
| `call.retry.backoff_s` | Finite, >= 0 seconds when declared |
| `call.poll.interval_s` | Finite, at least 0.1 seconds (busy-loop guard) |
| `call.poll.deadline_s` | Finite, at least `call.deadline_s` |
| `verify.maxDrives` | Integer >= 1; default 2 |
| Choice options (`pick`, `route`, question enums) | At most 240 (System-One question shape) |
| `deps.maxQuestionsPerRequest` | Positive safe integer; default 256 |
| `deps.maxStateBytesPerRequest` | Positive safe integer UTF-8 bytes of JSON judge state; no default |

The question guard applies before an adapter request. Static judge/verifier question sets are checked during admission. A `sift` asks items × questions, so when that exceeds `maxQuestionsPerRequest`, or the judge state would exceed `maxStateBytesPerRequest`, it splits the items in order into several requests that each fit. It runs up to four at a time and joins the answers onto the original items. The first failed request cancels the others. Each request carries the sift's `state` and only its own items, so ask questions about one item at a time. A sift that fits one request sends the same request as before. An item that cannot fit a request alone is refused before any request. Set `maxStateBytesPerRequest` from the provider's context limit, and at or below the Jev adapter's `maxStateBytes`, which measures the same bytes. The Jev adapter has no default byte ceiling; its host may explicitly set `maxStateBytes`. Provider token context limits still apply to the assembled state and questions; bytes are not a tokenizer. See the [current model contract](https://docs.typesafe.ai/models). “System One” names the TypeSafe family of typed judgments; Noul means the probability of yes.

## Check your changes

```sh
npm run check
npm run verify:packages
npm run export:source
```

The test suite checks structure, composition, decision handling, verification, effects, cancellation, SDK contracts, and retained candidates. Package verification installs tarballs into an empty consumer. Scripted model responses prove execution behavior, not model quality.


### Legacy v2 fields

Older documents may contain `agent.budget` or `decide.samples` and `decide.voteField`. These fields are tolerated for compatibility but ignored: each node invokes its adapter once. Remove them when migrating; configure resource limits in the host and express repeated execution explicitly with bounded workflow nodes.
