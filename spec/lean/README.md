# AgentRun semantics in Lean

A Lean 4 model of the workflow language that `packages/dsl` interprets, with theorems about what `validateWorkflow` and `runWorkflow` guarantee, and a conformance corpus that both the model and the TypeScript interpreter must agree on.

The model uses core Lean and its standard library only. No Mathlib.

## Run it

Install [elan](https://github.com/leanprover/elan). The toolchain version comes from `lean-toolchain`.

```sh
cd spec/lean
lake build              # builds the model and checks every proof and the axiom audit
lake exe conformance    # runs every case in conformance/ against the model
```

The TypeScript side of the same corpus runs with the package tests:

```sh
npm run build
node --test packages/dsl/test/lean-conformance.test.mjs
```

A clean `lake build` takes about 20 seconds.

## What is modeled

| Lean | TypeScript |
| --- | --- |
| `Value.lean`: JSON values, state, the two `getPath` functions, `hasConcreteValue` | `workflow.ts`, `predicates.ts` |
| `Syntax.lean`: every node kind, predicates, templates, child workflows | `WorkflowNode`, `Predicate` |
| `Semantics.lean`: `eval`, one case per node kind, the parallel merge, `stepWrap` | `runNodeOnState`, `runNodeBody`, `mergeStageDelta` |
| `Validate.lean`: the structural rules of `validateWorkflow` | `validateWorkflow` |
| `Desugar.lean` | `desugarWorkflow` |
| `Run.lean`: validate, check input, run, project output | `runWorkflow` |

Everything the interpreter delegates is a field of `Oracle`: `runNode`, `runJudge`, `runEffect`, code execution, `ask` predicates, JSON Schema checks, the host policy's `decodeSubmission` and `afterNode`, and which of several concurrent failures is reported. Every theorem quantifies over every oracle.

### What each oracle boundary hides

A theorem sees only what the engine does with an oracle's answer. Behavior inside a boundary is invisible to every theorem here:

| Oracle | Folds together | Invisible to the theorems |
| --- | --- | --- |
| `gen`, `report` (`runNode`) | The adapter session, `normalizeStringNullsForSchema`, the transport schema, `decodeSubmission`, stage-schema validation, `mergeStageDelta`'s filter to declared properties, and the whole `verify` loop with its `runJudge` drives | Which properties the filter drops, whether a submission is schema-valid, how many review drives ran and what they saw, and the `$verify` record's contents. The model only knows the value lands at the node's key, plus `$verify` and `$host` |
| `judge`, `pick`, `sift`, `route`, `ask` (`runJudge`) | `validateAnswers`, `answersToValue`, the sidecar, sift's keep threshold, the question-count guard for static question sets | Answer validation failures other than as an adapter error, how confidences become values, and which items sift keeps and why |
| `effect` (`runEffect`) | Attempts, retry classes, backoff, deadlines, polling (`until`, `fail_when`, `interval_s`), memo reads and writes, the result schema check, `EffectOutcomeUnknownError` and late settlement | Every timing and retry property, and whether a poll ends. A `call` is one atomic answer, so F8 cannot be expressed in the model |
| `code` | Compiling and running the JavaScript transform | Anything the code does besides returning a value. Validation's code probes are not modeled |
| `schemaOk` | TypeBox `Check` against resolved schemas | Every schema-content rule |
| `afterNode` | The host's patch | Its content. Theorems that need a frame assume it is absent |
| `choose` | Which concurrent failure is reported | Timing: all branches and items run to completion in the model, and sibling cancellation is not modeled |

An oracle is a function of the call site, and a call site is its execution path. Within one run every oracle is called at most once per execution path: loop iterations, map items, branches and child workflows each extend the path. So a function loses nothing against a stateful adapter for a single run.

The validator model covers reachability of `requires`, `itemsPath` and interpolation heads, the reserved `$` keys, parallel disjointness as `declaredWrites` computes it, loop bounds, terminal report placement, output-path producers, artifact files produced by earlier shell calls, and child workflows validated with their invocation's input keys. It is a subset of the TypeScript rules, so every workflow the TypeScript validator accepts is accepted here and every theorem applies to it.

## What is not modeled

- **JSON Schema.** Schema compilation, `$ref` resolution, question schemas and typed path checks need a schema engine. Schema acceptance is the `schemaOk` oracle.
- **JavaScript.** Code nodes return what the `code` oracle says, and validation's code probes are not modeled. Conformance cases script each code node's return value, and the TypeScript test checks that the real code returned exactly that.
- **Effects in detail.** A `call`, including retries, polling, memoization and its deadline, is one atomic oracle call. The poll loop's bound is finding F8.
- **Host adapters, recovery, checkpoints, cancellation, cost and events other than control flow.** Recovery's `resume` and `commit`, checkpoint failure modes, abort signals and `onEvent` details are outside the model.
- **Prompt assembly and text rendering.** SOP slicing, instruction text, `describe` rendering and escalation summaries are not modeled. The pick option text is an oracle field.
- **Number and string details.** Numbers are rationals. `trim` uses ASCII whitespace. Property reads on strings, such as `length` or indexes, are not modeled. An adapter returning `undefined` is outside the model, because oracles return JSON values.
- **Which concurrent failure is reported.** When several map items or parallel branches fail, TypeScript reports the first to fail in time. The model leaves the choice to the oracle's `choose`, so theorems hold for any choice.
- **Schema catalogs.** In the model, schema ids share one namespace across parent and child workflows. Conformance cases keep them unique.

## Theorems

| Name | File | What it says |
| --- | --- | --- |
| `T1_requires_sound` | `Theorems/Requires.lean` | If validation accepts with the input's keys, no node the validator checked fails `required_nonempty` because the first key of a required path is absent. Assumes schema checks reject `undefined`. |
| `T1_as_stated_is_false` | `Findings.lean` | The stronger claim, that validation rules out `required_nonempty` entirely, is false. |
| `T2_frame` | `Theorems/Writes.lean` | A completed node changes only keys in `mayWrite`: its `as` or label, the `$answers` and `$verify` sidecars, `report_markdown`, `artifact`, and `$host` for generative nodes. Holds for any oracle without `afterNode`. `$host` is untouched outside generative nodes even with `afterNode`. |
| `T2_parallel_no_domain_conflict` | `Theorems/Parallel.lean` | If no two branches may write the same key, apart from `$host`, the merge raises no domain write conflict. |
| `T2_merge_order_independent` | `Theorems/Parallel.lean` | The domain merge's success and every merged key are invariant under any permutation of branch results. |
| `T3_loop_ignores_late_iterations` | `Theorems/Loop.lean` | A loop's result does not depend on its body at any iteration index at or above `maxIters`. |
| `T3_loop_exit_count` | `Theorems/Loop.lean` | When `until` holds, it held after iteration `n` with `1 ≤ n ≤ maxIters`. |
| `T3_loop_events` | `Theorems/Loop.lean` | Every event of a loop is its own exit event or lies under `iterations/j` with `j < maxIters`. |
| `T3_runWorkflow_total` | `Theorems/Loop.lean` | Every run ends `complete`, `escalated` or `failed`. The content is that `eval` is structurally recursive, which the kernel checks, with each loop's fuel being its `maxIters`. |
| `T4_eval_desugar` | `Theorems/Desugar.lean` | Running a desugared node is running the node, for every oracle. |
| `T4_validate_desugar`, `T4_runWorkflow_desugar` | `Theorems/Desugar.lean` | Validation and `runWorkflow` cannot tell a workflow from its desugaring. |

Two limits apply to what these results establish:

- **Conformance pins agreement, not equivalence.** The conformance cases were recorded from the TypeScript implementation and then matched by the model. They pin agreement on those cases and cannot establish that the implementation is equivalent to the model.
- **Totality is not liveness.** `T3_runWorkflow_total` is termination of the model, whose oracles answer atomically. It says nothing about the liveness of a run against live adapters. F8 is the concrete gap: under a recovery adapter, the engine's poll loop has no bound.

The validator mirror is checked the other way as well: `lake exe validator-sweep` asserts that the Lean validator accepts every workflow the TypeScript validator accepts. The corpus is every workflow the repository's own test suites pass to the public API, plus the conformance cases and the author skill examples (see [the sweep](#validator-sweep)).

`AgentRunSemantics/Check.lean` prints the axioms of every theorem and fails the build if any theorem depends on more than `propext`, `Classical.choice` and `Quot.sound`. Counterexamples are evaluated by the kernel with `decide +kernel`, never `native_decide`.

<a id="findings"></a>
## Findings

Each open finding has a kernel-checked counterexample in `Findings.lean`, a conformance case that pins the current TypeScript behavior, and a `todo` test in `packages/dsl/test/lean-findings.test.mjs` that asserts the claim and fails. A fixed finding keeps its case with the corrected expectation, a theorem of the fixed behavior, and a live test.

Disposition: **fix** is a shipped runtime defect, **validator** is a check `validateWorkflow` should gain, and **document** is behavior that stays and the docs must state. Nothing here changes runtime behavior.

| Id | Disposition | Finding | Case |
| --- | --- | --- | --- |
| F1 | validator | Validation does not rule out `required_nonempty`. After the first `code`, `map`, `parallel`, `loop` or `route` on the walk, `requires` is not checked at all. Where it is checked, only the first key must have a producer; the value can still be empty or the nested path missing. | `requires-after-code`, `requires-empty-submission` |
| F2 | validator | Parallel disjointness uses `declaredWrites`, which ignores labels of unaliased generative nodes, keys returned by unaliased code nodes, and the `$answers` and `$verify` sidecars. Such workflows validate and then fail with `parallel_write_conflict`. | `parallel-code-collision`, `parallel-label-collision` |
| F3 | document | An unaliased code node may write `$`-prefixed keys other than `$host`. The host-integration guide says no workflow may name one. | `code-writes-dollar-key` |
| F4 | validator | A child invocation whose `input` names `$host` passes validation and fails at run time with `input_invalid`. | `child-input-host` |
| F5 | validator | A child whose output schema accepts `undefined` can leave its parent's `as` undefined, and a validated `requires` on it then fails. T1 needs its schema hypothesis. | `child-undefined-output` |
| F6 | document | "A node writes only its `as` or label, plus `$host`" understates the write set: judges and picks write `<as>$answers`, verified nodes write `<as>$verify`, unaliased code nodes write whatever they return, and `afterNode` may write any key but `$host`. `mayWrite` in `T2_frame` is the accurate set. | none; see `F6_writes_beyond_as_or_label` |
| F7 | fixed | A scalar write and an array write on the same new `$host` key are a `parallel_write_conflict` in either branch order (`T2_host_mixed_shape_conflicts_either_order`); before, one order silently replaced the scalar. Appends still join in branch order by design (`T2_host_merge_order_dependent`). | `parallel-host-scalar-then-array`, `parallel-host-array-then-scalar`, `parallel-host-append` |
| F8 | fix | With `deps.recovery` set, a polled `call` has no engine bound: the deadline checks are skipped and termination rests on the host's recovery adapter. The guide states this as a host obligation. | TypeScript test only; calls are atomic in the model |
| F9 | fixed | One resolver serves predicates, `requires`, interpolation, `itemsPath` and `output.path` (`F9_fixed_one_resolver`): a record by key, an array by a canonical in-bounds index, anything else to `undefined`. A gate on `scores.0` fires when `{scores.0}` resolves (`F9_fixed_predicate_indexes_arrays`). | `predicate-array-index` |

<a id="validator-sweep"></a>
## Validator sweep

Every theorem assumes the Lean validator accepts the workflow. That TypeScript acceptance implies Lean acceptance is argued rule by rule in `Validate.lean`. The sweep supplies the empirical half:

```sh
npm run build
node spec/lean/sweep/collect.mjs spec/lean/.lake/validator-corpus.json
cd spec/lean && lake exe validator-sweep .lake/validator-corpus.json
```

`collect.mjs` runs the DSL, Pi and example test suites with an import hook (`sweep/capture-*.mjs`). The hook records every workflow passed to `validateWorkflow`, `runWorkflow`, `runWorkflowSlice`, `runTypedWorkflow` and `dryRunWorkflow`, with the input keys of that call. The collector adds the author skill's examples (with their sample inputs' keys) and the conformance workflows, then records the TypeScript validator's verdict for each. `validator-sweep` fails if the Lean validator rejects any workflow TypeScript accepts. CI runs both steps live, so a rule added to one validator only, or relaxed on the TypeScript side only, fails the `lean` job. The direction is one-way on purpose: the Lean validator checks a subset of the rules, so rejecting less than TypeScript is expected.

## Add a conformance case

1. Write `conformance/<name>.json` with `workflow`, `input`, and a `script` of adapter answers keyed by execution path (`gen`, `judge`, `effect`, `after`).
2. Record the TypeScript result with `npm run build`, then `node spec/lean/conformance/record.mjs spec/lean/conformance/<name>.json`. The recorder also fills each code node's return value. Review the diff: a recorded change is a behavior change.
3. Run `lake exe conformance`. The model must agree before the case lands.

## Add a theorem

Put it in `AgentRunSemantics/Theorems/`, import the file from `AgentRunSemantics.lean`, and add a `#print axioms` entry under `#guard_msgs` in `AgentRunSemantics/Check.lean`. A claim that turns out false stays false: add its counterexample to `Findings.lean` and a `todo` test instead of weakening the statement.
