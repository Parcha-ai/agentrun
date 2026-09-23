# Build with agent.run()

AgentRun defines workflows that combine tools, code, Jev system one decisions, and agents. Models return typed results; code checks schemas and controls execution.

<a id="quickstart"></a>
## Start with an example

Use Node 22.19+ and npm. Follow the [support example](../README.md#run-the-support-example) to install, build and run the support example without credentials. It searches for an answer, checks it, and calls an agent only when investigation is needed. [Connect your own tools and models](support-quickstart.md) after the scripted example works.

For TypeScript authoring and reusable child workflows, follow the [research tutorial](authoring.md). The [standalone starter](../examples/starter/README.md) runs outside this checkout. See [all examples](examples.md) for their commands and failure paths.

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

Structural checks, including unknown node fields, always run. Supplied inputs also check the input schema and reachable input keys. Dry-run checks synthetic execution wiring, not model quality or effect delivery. `ok` with `skipped` means a path could not be exercised (for example, a synthetic judgment escalated or a schema cannot be synthesized); read those reasons rather than treating it as execution proof.

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

With [Pi 0.87.0 installed](../packages/pi/README.md#install), run these commands in your project:

```sh
pi install npm:@parcha/agentrun-pi@0.1.0-beta.2 -l
pi --offline
```

`-l` installs in this project. `--offline` skips startup downloads, not intentional model calls. Pi asks whether you trust the project before loading its extension on first launch.

Inside Pi, run `/agentrun demo` to see a scripted research workflow without making model calls. Run `/agentrun status` to confirm that the authoring skill loaded. If Pi 0.87.0 is already open, use `/reload` first. The npm package includes the extension and skill; no AgentRun checkout is needed.

With model access configured in Pi, describe a task:

```text
/agentrun Research how this repository handles cancellation. Investigate the runtime and tests separately, then report the gaps with file references.
```

The packaged skill has Pi inspect the available tools, build a workflow, and run its steps with the selected Pi model. `/agentrun` shows the graph; `/agentrun stop` requests cancellation. Jev access is needed only for system one decisions. Native workflows are session-local; named saves are planned for V2. See [Pi setup and limits](../packages/pi/README.md).

### Embed the Pi SDK

Use `createPiHostRunner` inside an existing Pi extension or `createPiRunner` with a configured standalone SDK runtime. Supply tools explicitly. The runner forwards schema and review feedback to the same agent session, bounds turns and submissions, and honors cancellation.

For authoring, `authorWorkflow` retains a candidate and its feedback without activating it. Supply your own acceptance callback to evaluate behavior. Without that callback, acceptance checks structure only.

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
| `route` | Choose a branch by meaning, with an explicit uncertain fallback. |
| `agent`, `decide`, `extract` | Obtain a schema-checked result from an agent adapter. |
| `code` | Apply a trusted JavaScript state transformation. |
| `call` | Delegate a bounded tool, executor, or shell effect to the host. |
| `workflow` | Invoke an isolated child with explicit input/output contracts. Children can compose maps, loops, routes, parallel branches and children; terminal reports/artifacts stay with the parent. |
| `escalate` | Stop with the reason and current state for the host to handle. |
| `report`, `artifact` | Declare terminal prose or file metadata; the host owns delivery. |

Start with `chain`, `agent`/`extract`, `judge`, `code`, and `escalate`. Add collection and concurrency nodes when the workflow needs them. `report`, `artifact`, shell/executor transports, recovery and slices are advanced host integration; the host implements tools, delivery and storage.

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
- **Loop exits.** `loop.exited` reports `condition_met` or `bound_reached` and the iteration count. Reaching the bound keeps the current state; use a following gate if it should escalate.
- **Recovery.** Checkpoint, memo, and recovery interfaces are host hooks, not a bundled durable scheduler. In legacy graphs, repeated calls with the same label, transport and resolved input share an idempotency key, including across loop iterations. A memo hit reuses the earlier result. Use `call.poll` for repeated status checks; for distinct operations, include an operation identifier in the call input. Newly composed child graphs require `recovery.supportsExecutionPaths: true` and stores keyed by the full execution path; see [host integration](host-integration.md). Required checkpoint writes can stop execution. A durable receipt may be read after poll expiry within the node deadline; the host must reject any fresh admission after the original poll deadline. A completed run alone does not prove file delivery.
- **Observability.** `onEvent` is best effort and is not awaited; thrown errors and rejected promises from observers cannot change a workflow outcome. Use required checkpoint hooks to gate persistence. `onEvent` reports runtime events. Raw state, answers, candidate files, and error evidence may contain application data; the host controls storage, access, retention, and redaction.
- **Versioning.** The author creates new candidate files in unique directories and refuses to overwrite an existing draft. The filesystem remains host-controlled; this is not tamper-proof storage. Activation, rollback, ownership, budgets, and cross-agent coordination remain outside the core. This beta's API may change.

### Numeric limits

These are engine bounds, not provider capacity guarantees. Hosts can impose tighter budgets. Node transport limits remain part of the v2 contract; changes require a versioned candidate.

| Setting | Bound / default |
| --- | --- |
| `loop.maxIters` | Integer 1–20, required |
| `map.maxConcurrency` | Positive safe integer; default 4 |
| `call.deadline_s` | Greater than 0, at most 3600 seconds |
| `call.retry.attempts` | Integer 1–5 when retry is declared |
| `call.poll.interval_s` | 0.1–300 seconds |
| `call.poll.deadline_s` | At least `call.deadline_s`, at most 7200 seconds |
| `verify.maxDrives` | Integer 1–4; default 2 |
| Choice options (`pick`, `route`, question enums) | At most 240 |
| `deps.maxQuestionsPerRequest` | Positive safe integer; default 256 |

The question guard applies before an adapter request. Static judge/verifier question sets are checked during admission; `sift` checks items × questions at execution because its collection may be produced by earlier nodes. It does not batch or retry an oversized request. Reduce the collection or explicitly raise the host guard after checking provider capacity. The Jev adapter has no default byte ceiling; its host may explicitly set `maxStateBytes`. Provider token context limits still apply to the assembled state and questions; bytes are not a tokenizer. See the [current model contract](https://docs.typesafe.ai/models). “System One” names the TypeSafe family of typed judgments; Noul means the probability of yes.

## Check your changes

```sh
npm run check
npm run verify:packages
npm run export:source
```

The test suite checks structure, composition, decision handling, verification, effects, cancellation, SDK contracts, and retained candidates. Package verification installs tarballs into an empty consumer. Scripted model responses prove execution behavior, not model quality.


### Legacy v2 fields

Older documents may contain `agent.budget` or `decide.samples` and `decide.voteField`. These fields are tolerated for compatibility but ignored: each node invokes its adapter once. Remove them when migrating; configure resource limits in the host and express repeated execution explicitly with bounded workflow nodes.
