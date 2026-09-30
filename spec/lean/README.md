# AgentRun semantics in Lean

A contributor specification for selected validation and execution rules in `packages/dsl`. Lean checks proofs about this model under their stated assumptions. Shared test cases compare it with the TypeScript interpreter; the implementation is not formally verified by these proofs.

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
| `Value.lean`: JSON values, state, the shared `getPath` resolver, `hasConcreteValue` | `workflow.ts`, `predicates.ts` |
| `Syntax.lean`: every node kind, predicates, templates, child workflows | `WorkflowNode`, `Predicate` |
| `Semantics.lean`: `eval`, one case per node kind, the parallel merge, `stepWrap` | `runNodeOnState`, `runNodeBody`, `mergeStageDelta` |
| `Validate.lean`: the structural rules of `validateWorkflow` | `validateWorkflow` |
| `Desugar.lean` | `desugarWorkflow` |
| `Run.lean`: validate, check input, run, project output | `runWorkflow` |

Everything the interpreter delegates is a field of `Oracle`: `runNode`, `runJudge`, `runEffect`, code execution, `ask` predicates, JSON Schema checks, the host policy's `decodeSubmission` and `afterNode`, and which of several concurrent failures is reported. The execution theorems quantify over oracle functions subject to their stated assumptions.

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

The validator model covers reachability of `requires`, `itemsPath` and interpolation heads, the reserved `$` keys, parallel disjointness as `declaredWrites` computes it, loop bounds, terminal report placement, output-path producers, artifact files produced by earlier shell calls, and child workflows validated with their invocation's input keys. It is intended to check a subset of the TypeScript rules. The validator sweep tests that relationship on the collected corpus; it does not prove it for all workflows.

## What is not modeled

- **JSON Schema.** Schema compilation, `$ref` resolution, question schemas and typed path checks need a schema engine. Schema acceptance is the `schemaOk` oracle.
- **JavaScript.** Code nodes return what the `code` oracle says, and validation's code probes are not modeled. Conformance cases script each code node's return value, and the TypeScript test checks that the real code returned exactly that.
- **Effects in detail.** A `call`, including retries, polling, memoization and its deadline, is one atomic oracle call. Recovery polling relies on the host admission contract described in F8.
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
| `T2_parallel_no_domain_conflict` | `Theorems/Parallel.lean` | If no two branches may write the same key, apart from `$host`, the merge raises no domain write conflict. Assumes the branches complete and `afterNode` is absent. |
| `T2_merge_order_independent` | `Theorems/Parallel.lean` | The domain merge's success and every merged key are invariant under any permutation of branch results. |
| `T3_loop_ignores_late_iterations` | `Theorems/Loop.lean` | A loop's result does not depend on its body at any iteration index at or above `maxIters`. |
| `T3_loop_exit_count` | `Theorems/Loop.lean` | When `until` holds, it held after iteration `n` with `1 ≤ n ≤ maxIters`. |
| `T3_loop_events` | `Theorems/Loop.lean` | Every event of a loop is its own exit event or lies under `iterations/j` with `j < maxIters`. |
| `T3_runWorkflow_total` | `Theorems/Loop.lean` | Every run ends `complete`, `escalated` or `failed`. The content is that `eval` is structurally recursive, which the kernel checks, with each loop's fuel being its `maxIters`. |
| `T4_eval_desugar` | `Theorems/Desugar.lean` | Running a desugared node is running the node, for every oracle. |
| `T4_validate_desugar`, `T4_runWorkflow_desugar` | `Theorems/Desugar.lean` | Validation and `runWorkflow` cannot tell a workflow from its desugaring. |
| `jev_route_below_threshold`, `jev_route_at_or_above_threshold`, `jev_route_undeclared_fails` | `Theorems/Jev.lean` | Route applies its declared confidence policy, preserves the original choice, and evaluates only the selected body; an undeclared answer fails first. |
| `dispatch_declared_string`, `dispatch_missing_fallback`, `dispatch_missing_fails`, `dispatch_selected_continuation` | `Theorems/Dispatch.lean` | A stored string selects its declared body; missing values follow the explicit fallback or fail; selection itself makes no oracle call. |

Two limits apply to what these results establish:

- **Conformance pins agreement, not equivalence.** The conformance cases were recorded from the TypeScript implementation and then matched by the model. They pin agreement on those cases and cannot establish that the implementation is equivalent to the model.
- **Totality is not liveness.** `T3_runWorkflow_total` is termination of the model, whose oracles answer atomically. It says nothing about the liveness of a run against live adapters. In F8, a recovery adapter must reject fresh admission after the original deadline while still allowing reads of completed receipts.

The validator mirror is checked the other way as well: `lake exe validator-sweep` asserts that the Lean validator accepts every TypeScript-accepted workflow in its corpus. The corpus is every workflow the repository's own test suites pass to the public API, plus the conformance cases and the author skill examples (see [the sweep](#validator-sweep)).

`AgentRunSemantics/Check.lean` prints the axioms of every theorem and fails the build if any theorem depends on more than `propext`, `Classical.choice` and `Quot.sound`. Counterexamples are evaluated by the kernel with `decide +kernel`, never `native_decide`.

<a id="findings"></a>
## Findings

The table records counterexamples and their disposition. Findings F6 and F8 have the evidence noted in their rows rather than a shared conformance case. The tests in `packages/dsl/test/lean-findings.test.mjs` assert the intended runtime protections and the fixed validation defect. Static validation cannot predict arbitrary code patches or future model output. [Issue #10](https://github.com/Parcha-ai/agentrun/issues/10) records follow-up opportunities for earlier diagnostics.

Disposition: **fixed** has a regression test, **runtime** needs values produced during execution, **host** is an adapter obligation, and **document** is intentional behavior. The model is separate from the runtime; each runtime fix needs its own TypeScript change and regression test.

| Id | Disposition | Finding | Case |
| --- | --- | --- | --- |
| F1 | runtime | Static reachability stops after dynamic control flow and tracks producers, not future values. At execution, `requires` rejects missing or empty values before constructing the consuming agent. More static reachability checks could improve diagnostics; they cannot guarantee non-empty model output. | `requires-after-code`, `requires-empty-submission` |
| F2 | runtime | Arbitrary code patches need the runtime `parallel_write_conflict` guard. Static `declaredWrites` also omits predictable unaliased labels and `$answers`/`$verify` sidecars; checking those earlier remains a diagnostic improvement. Conflicting branches cannot silently overwrite each other. | `parallel-code-collision`, `parallel-label-collision` |
| F3 | document | An unaliased code node may write `$`-prefixed keys other than `$host`. `as` keys and labels used as state keys by unaliased `agent`, `decide`, `extract`, and `code` nodes reject that prefix. Patches reserve `$host` specifically. The host-integration guide states this boundary. | `code-writes-dollar-key` |
| F4 | fixed | Validation rejects a child invocation whose top-level `input` names `$host`, before any parent or child node executes. Nested data and other `$`-prefixed input keys remain allowed. | `child-input-host` |
| F5 | runtime | A permissive child output schema can allow `undefined`; `requires` then rejects it. An explicit parent output type rejects it at the child boundary instead. Authors must declare the output they need. T1 needs its schema hypothesis. | `child-undefined-output` |
| F6 | document | "A node writes only its `as` or label, plus `$host`" understates the write set: judges and picks write `<as>$answers`, verified nodes write `<as>$verify`, unaliased code nodes write whatever they return, and `afterNode` may write any key but `$host`. `mayWrite` in `T2_frame` is the accurate set. | none; see `F6_writes_beyond_as_or_label` |
| F7 | fixed | A scalar write and an array write on the same new `$host` key are a `parallel_write_conflict` in either branch order (`T2_host_mixed_shape_conflicts_either_order`); before, one order silently replaced the scalar. Appends still join in branch order by design (`T2_host_merge_order_dependent`). | `parallel-host-scalar-then-array`, `parallel-host-array-then-scalar`, `parallel-host-append` |
| F8 | host | With `deps.recovery`, the host must reject fresh admission and further polling after the original deadline. Reading a completed durable receipt after expiry is allowed. The integration test covers absent, incomplete and completed receipts; an adapter that ignores this contract can poll indefinitely. | TypeScript test only; calls are atomic in the model |
| F9 | fixed | One resolver serves predicates, `requires`, interpolation, `itemsPath` and `output.path` (`F9_fixed_one_resolver`): a record by key, an array by a canonical in-bounds index, anything else to `undefined`. A gate on `scores.0` fires when `{scores.0}` resolves (`F9_fixed_predicate_indexes_arrays`). | `predicate-array-index` |

<a id="validator-sweep"></a>
## Validator sweep

For theorems that assume Lean validation succeeds, applying the result to a TypeScript-accepted workflow also requires agreement between the validators. `Validate.lean` describes the intended correspondence; the sweep checks the acceptance direction on collected examples:

```sh
npm run build
node spec/lean/sweep/collect.mjs spec/lean/.lake/validator-corpus.json
cd spec/lean && lake exe validator-sweep .lake/validator-corpus.json
```

`collect.mjs` runs the DSL, Pi and example test suites with an import hook (`sweep/capture-*.mjs`). The hook records every workflow passed to `validateWorkflow`, `runWorkflow`, `runWorkflowSlice`, `runTypedWorkflow` and `dryRunWorkflow`, with the input keys of that call. The collector adds the author skill's examples (with their sample inputs' keys) and the conformance workflows, then records the TypeScript validator's verdict for each. `validator-sweep` fails if the Lean validator rejects a workflow that TypeScript accepts in that corpus. CI runs both steps live, so incompatible validator changes exercised by the corpus fail the `lean` job. The direction is one-way on purpose: the Lean validator is intended to check fewer rules, so it may accept workflows TypeScript rejects.

## Add a conformance case

1. Write `conformance/<name>.json` with `workflow`, `input`, and a `script` of adapter answers keyed by execution path (`gen`, `judge`, `effect`, `after`).
2. Record the TypeScript result with `npm run build`, then `node spec/lean/conformance/record.mjs spec/lean/conformance/<name>.json`. The recorder also fills each code node's return value. Review the diff: a recorded change is a behavior change.
3. Run `lake exe conformance`. The model must agree before the case lands.

## Add a theorem

Put it in `AgentRunSemantics/Theorems/`, import the file from `AgentRunSemantics.lean`, and add a `#print axioms` entry under `#guard_msgs` in `AgentRunSemantics/Check.lean`. When a claim is false, retain its counterexample in `Findings.lean` and record its disposition in the findings table. Test documented behavior with a passing assertion. Use an executable `todo` reproducer for a pending fix, and remove the marker when the fix lands. State any narrower theorem and its assumptions explicitly.
