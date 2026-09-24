# @parcha/agentrun-dsl

Composable, typed workflows for agents. The core provides the v2 workflow types, validator, interpreter, events, schema, and an offline CLI. Supply agent, judgment, and effect functions only when a workflow needs them.

Beta: `0.1.0-beta.4`. Requires Node 22.19+; TypeScript consumers require TypeScript 5.4+.

```sh
npm install @parcha/agentrun-dsl@beta
npx agentrun demo
```

For the JavaScript API, save this as `demo.mjs` and run `node demo.mjs`:

```js
import { runTriageDemo } from '@parcha/agentrun-dsl/demo';
const { result } = await runTriageDemo('billing');
console.log(result.output); // { queue: 'billing', priority: 'normal' }
```

The demo runs real control flow with scripted judgments. `ambiguous` escalates. No model SDK or API key is required by the core. Optional `@parcha/agentrun-jev` and `@parcha/agentrun-pi` adapters add live judgments and agent steps.

The `agentrun` CLI provides `demo`, `example`, `inspect`, `validate`, `dry-run`, and deterministic `run`. `inspect workflow.json [--json]` displays structure without executing code. Validation/run require `--trusted` because workflow JavaScript can execute, including during validation. This package is not an isolation boundary.

`runWorkflow(workflow, input, deps)` returns a complete schema-validated output or an escalation; its TypeScript output type is `unknown`. `defineWorkflow` binds Standard JSON Schema contracts, including supported Zod schemas, to a frozen v2 document; `runTypedWorkflow` infers those input/output types and delegates to the same interpreter. Intermediate state paths remain runtime-validated. Execution and verification failures throw. Hosts own tools, durable storage, file delivery, idempotency, recovery, and activation.

Raw JSON schemas retain `unknown` boundary types. Zod transforms, refinements, defaults and coercion are rejected rather than silently dropped. The core does not depend on Zod at runtime. Other Standard JSON Schema providers must faithfully represent their contracts. Typed execution accepts the original `defineWorkflow` result; copied or deserialized documents use `runWorkflow`.

## Public API

The package root exports a deliberate API. The beta retains agent, structured-output, report, artifact, effect, child-workflow and focused-evaluation paths. Hosts supply their adapters and policy; a workflow cannot grant itself tool permissions.

| Group | Exports and purpose |
| --- | --- |
| Typed authoring | `defineWorkflow`, `runTypedWorkflow`, `WorkflowSchemaConversionError`; `StandardJSONSchema`, `AuthoringSchema`, `TypedWorkflow`, `WorkflowInput`, `WorkflowOutput`, `TypedWorkflowRunResult`. |
| Structural inspection | `inspectWorkflow`, `formatWorkflowTree`; `WorkflowInspection`, `WorkflowInspectionNode`. Reads structure and capability requirements; does not perform semantic validation or run code probes. |
| Run and inspect | `runWorkflow`, `validateWorkflow`, `workflowSha256`, `dryRunWorkflow`; core contracts `Workflow`, `WorkflowNode`, `WorkflowDeps`, `WorkflowRunResult`, plus the named node, predicate, effect, effort and result types. |
| Recognize outcomes | `WorkflowInvalidError`, `WorkflowInputInvalidError`, `WorkflowOutputInvalidError`, `WorkflowVerificationError`, `EffectFailure`, `EffectDeadlineExceededError`, `EffectOutcomeUnknownError`, `EscalationSignal`. A concurrent failure may contain typed outcomes in `AggregateError.errors`; inspect them before deciding whether an effect is safe to retry. |
| Build judgment adapters | `compileQuestions`, `validateAnswers`, `answersToValue`, `answersSidecar`, `answerConfidence`, `SYSTEM_ONE_LIMITS`, `SystemOneError`; `SystemOneQuestion`, `SystemOneAnswer`, `SystemOneResult`, `SystemOneRetryClass`, `CompiledQuestions`, `AnswersSidecar`. |
| Integrate a host | `runWorkflowSlice`, `assertWorkflowCapabilities`, `desugarWorkflow`, `resolveSchemaForWorkflow`, `stageSchemaForNode`, `submissionSchemaForNode`, `mergeStageDelta`, `REPORT_SCHEMA`, `SHELL_RESULT_SCHEMA`, `getPath`, `predicateMatches`. |
| Author workflows | `authorContract`, `renderAuthorContract` (text and sha256), `renderAuthorHostAddendum`, `authorWorkflow`, `candidatePolicyErrors`, `applyHostOutputTypes`, `AUTHOR_SKILL_NAME`, `authorSkillDirectory`, `loadAuthorReference`, `loadAuthorSkillBundle`; `AuthorHostAddendum`, `AuthorWorkflowOptions`, `AuthoredWorkflow`, `CandidatePolicyOptions`. The one author contract and its packaged skill (`skills/author`); a host adds only an addendum. See [the author contract](../../docs/authoring.md#one-author-contract). |
| Language vocabulary | `WORKFLOW_NODE_KINDS`, `GENERATIVE_NODE_KINDS`, `JUDGMENT_NODE_KINDS`, `NODE_FIELDS`, `IGNORED_NODE_FIELDS`, `WORKFLOW_PREDICATES`, `MECHANICAL_PREDICATES`, `PREDICATE_FIELDS`, `EFFORT_LEVELS`, `THINKING_LEVELS`, `MODEL_TIERS`, `CALL_TRANSPORTS`, `CALL_RETRY_CLASSES`, `PROSE_ARTIFACT_TYPES`; `WorkflowNodeKind`, `WorkflowPredicateName`. The validator and the author contract read these same constants. |
| Test without a model | `synthesizeInstance`, `synthesizeAnswers`, `DryRunOptions`, `DryRunResult`. Synthetic answers exercise execution mechanics; they do not establish judgment quality. |

`runWorkflowSlice` runs selected root steps against supplied state and optional seed data. It returns the slice state without checking the full workflow's terminal output contract. Use `runWorkflow` for a complete run. `getPath` reads dot-separated record keys and canonical in-bounds array indexes, returning `undefined` when a segment cannot be resolved. `predicateMatches` evaluates mechanical predicates only; use `field_equals` with an explicit path for a stored label.

The schema helpers resolve the owning workflow's schema catalog; `stageSchemaForNode` and `submissionSchemaForNode` name the same submission contract. `mergeStageDelta` stores declared submission fields under the node's output key; callers must validate the submission first. Internal traversal, compilation, CSV, reference-file and input-normalization helpers are not package-root APIs.

The separate `@parcha/agentrun-dsl/demo` entrypoint provides the support-triage example. `@parcha/agentrun-dsl/schema` provides the generated workflow JSON Schema.

Children can contain maps, loops, routes, parallel branches and other children, and appear inside those structures. Their input/state and schema catalogs stay isolated; terminal report/artifact delivery remains parent-owned. New composed structures require path-aware recovery stores when recovery is enabled. `executionPath` is supplied to adapters, events and checkpoint/recovery hooks. Existing host validators and durable-cursor limits remain authoritative.

## Bounds

These are the current beta's validation limits. Hosts may impose tighter budgets; the bounds below are not configurable unless an override is named.

| Setting | Bound |
| --- | --- |
| Document traversal | At most 100,000 visited values and 128 levels of object nesting; cycles, accessors and proxies rejected |
| `loop.maxIters` | Integer 1–20 |
| `verify.maxDrives` | Integer 1–4; default 2 |
| `call.deadline_s` | Greater than 0 and at most 3,600 seconds |
| `call.retry.attempts` | Integer 1–5, including the first attempt |
| `call.poll.interval_s` | 0.1–300 seconds |
| `call.poll.deadline_s` | At least the call deadline and at most 7,200 seconds |
| Choice options / route branches | At most 240; `pick.allowNone` reserves one option |
| Score rubric | 2–10 levels, indexed from 0 |
| Questions per judgment request | Default 256; override with host-owned `WorkflowDeps.maxQuestionsPerRequest` |
| Jev context | Selected provider's token limits; an adapter host may configure an additional byte guard |

The question-count guard applies after collection expansion, including `sift` items multiplied by their questions. It is a host budget guard, not a claim about a provider's service limit.

`System One` names TypeSafe's typed-question interface used by the judgment types. A `noul` answer is a truth probability from 0 to 1; `answersToValue` turns values at least 0.5 into `true`. Choice and score confidence comes from the adapter response; Noul confidence is `2 × |probability − 0.5|`. Neither is a calibration guarantee.

## License

Apache-2.0. See the included LICENSE and NOTICE files.
