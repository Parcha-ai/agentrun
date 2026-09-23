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

`AgentRunSemantics/Check.lean` prints the axioms of every theorem and fails the build if any theorem depends on more than `propext`, `Classical.choice` and `Quot.sound`. Counterexamples are evaluated by the kernel with `decide +kernel`, never `native_decide`.

<a id="findings"></a>
## Findings

Each finding has a kernel-checked counterexample in `Findings.lean`, a conformance case that pins the current TypeScript behavior, and a `todo` test in `packages/dsl/test/lean-findings.test.mjs` that asserts the claim and fails.

| Id | Finding | Case |
| --- | --- | --- |
| F1 | Validation does not rule out `required_nonempty`. After the first `code`, `map`, `parallel`, `loop` or `route` on the walk, `requires` is not checked at all. Where it is checked, only the first key must have a producer; the value can still be empty or the nested path missing. | `requires-after-code`, `requires-empty-submission` |
| F2 | Parallel disjointness uses `declaredWrites`, which ignores labels of unaliased generative nodes, keys returned by unaliased code nodes, and the `$answers` and `$verify` sidecars. Such workflows validate and then fail with `parallel_write_conflict`. | `parallel-code-collision`, `parallel-label-collision` |
| F3 | An unaliased code node may write `$`-prefixed keys other than `$host`. The host-integration guide says no workflow may name one. | `code-writes-dollar-key` |
| F4 | A child invocation whose `input` names `$host` passes validation and fails at run time with `input_invalid`. | `child-input-host` |
| F5 | A child whose output schema accepts `undefined` can leave its parent's `as` undefined, and a validated `requires` on it then fails. T1 needs its schema hypothesis. | `child-undefined-output` |
| F6 | "A node writes only its `as` or label, plus `$host`" understates the write set: judges and picks write `<as>$answers`, verified nodes write `<as>$verify`, unaliased code nodes write whatever they return, and `afterNode` may write any key but `$host`. `mayWrite` in `T2_frame` is the accurate set. | none; see `F6_writes_beyond_as_or_label` |
| F7 | The `$host` parallel merge depends on branch order. Arrays append in branch order. A scalar write followed by an array write on the same new key is silently replaced, and the reverse order is a conflict. | `parallel-host-scalar-then-array`, `parallel-host-array-then-scalar`, `parallel-host-append` |
| F8 | With `deps.recovery` set, a polled `call` has no engine bound: the deadline checks are skipped and termination rests on the host's recovery adapter. The guide states this as a host obligation. | TypeScript test only; calls are atomic in the model |
| F9 | Predicates read paths with the `predicates.ts` `getPath`, which stops at arrays. `requires` and interpolation use the `workflow.ts` `getPath`, which indexes them. A gate on `scores.0` never fires while `{scores.0}` resolves. | `predicate-array-index` |

## Add a conformance case

1. Write `conformance/<name>.json` with `workflow`, `input`, and a `script` of adapter answers keyed by execution path (`gen`, `judge`, `effect`, `after`).
2. Record the TypeScript result with `npm run build`, then `node spec/lean/conformance/record.mjs spec/lean/conformance/<name>.json`. The recorder also fills each code node's return value. Review the diff: a recorded change is a behavior change.
3. Run `lake exe conformance`. The model must agree before the case lands.

## Add a theorem

Put it in `AgentRunSemantics/Theorems/`, import the file from `AgentRunSemantics.lean`, and add a `#print axioms` entry under `#guard_msgs` in `AgentRunSemantics/Check.lean`. A claim that turns out false stays false: add its counterexample to `Findings.lean` and a `todo` test instead of weakening the statement.
