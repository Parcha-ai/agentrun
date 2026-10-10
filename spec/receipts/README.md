# Receipts: a TLA+ model of what a recovery driver keeps across a crash

`Receipts.tla` models the at-most-once rule a durable host relies on when it resumes a workflow: a recovery driver
runs the workflow's call steps over a journal (`RecoveryJournal` in
[`packages/dsl/src/recovery/store.ts`](../../packages/dsl/src/recovery/store.ts)), and no effect goes out twice,
whatever crashed and whichever commit failed. TLC checks it exhaustively at small bounds, with a crash or a failed
commit between any two actions. The same machine is proved in Lean for every number of steps and crashes
([`spec/lean/AgentRunRecovery/Frozen.lean`](../lean/AgentRunRecovery/Frozen.lean)).

## What is modeled

| Actor | Does | Where the rule lives |
| --- | --- | --- |
| driver | Walks the workflow's call steps in order. Each effect is admitted to the journal before it dispatches and completed with its result after, each in one commit with the driver's state. A resume answers a completed effect from the journal and refuses one admitted and never completed. | `RecoveryJournal.admit` and `complete` (their contract in `store.ts`); `WorkflowDeps.recovery` in `packages/dsl/src/workflow.ts`, which also runs no call retry under recovery |
| worker | May crash between any two actions, losing what only its process held (an admission not yet dispatched, the effect in flight); the host restarts it under the same identity, from a checkpoint at or before the journal's position (the first step, when it runs the workflow again from the top), so a resume passes completed effects again. | |
| storage | Any commit may fail. A failed commit stops the run, and no later commit is made through that open. | `RecoveryJournal`: a write lands whole or not at all, and is refused once a later open has taken the journal |

### What is not modeled

- Pause and cancel. They are the host's, and they stop a run between steps.
- The interpreter's paths inside a step (loops, maps, routes, child workflows): which execution path a commit
  belongs to. The model treats a workflow as one ordered list of call steps.
- An agent's own tool calls inside a step, and their replay classes: the agent runtime's.
- A second writer. `RecoveryStore.open` gives a journal one owner at a time; the model has one worker.

## Properties

| Property | Holds that |
| --- | --- |
| `I1_AdmitBeforeDispatch` | an effect is on the journal before it goes out |
| `I3_OneDispatchPerKey` | no effect key goes out twice, whatever crashed |
| `I3_CallRefused` | the driver never moves past an effect it did not complete |
| `I6_NoAdmissionAfterFault` | nothing is admitted after a commit failed |
| `I7_CompletedDispatchedOnce` | a completed effect went out exactly once |
| `I7_DoneSettledEveryCall` | a finished run completed every effect |
| `I7_ReceiptsNeverErased` | a completed receipt is never erased or changed |

## How to run

Java 11 or later, [`tla2tools.jar`](https://github.com/tlaplus/tlaplus/releases) (CI uses v1.7.4), and for
`check-receipts.sh` GNU coreutils' `timeout` (on macOS, `gtimeout` from Homebrew's `coreutils` is used when
`timeout` is absent):

```sh
TLA2TOOLS=/path/to/tla2tools.jar scripts/spec/check-receipts.sh        # Receipts.cfg and ReceiptsFull.cfg
TLA2TOOLS=/path/to/tla2tools.jar node scripts/spec/receipts-mutants.mjs # every guard mutant is caught by its named property
```

`Receipts.cfg` has two call steps and two crashes; `ReceiptsFull.cfg` six of each. Both allow a commit to fail at
any point. Each takes a few seconds.

The `receipts-spec` CI job runs both when a change touches `spec/receipts/`, `scripts/spec/` or its action, and
`receipts-spec-nightly.yml` checks `main` every night.

## Mutants

Each mutant in `scripts/spec/receipts-mutants.mjs` breaks one guard a driver relies on and names the property that
must catch it:

- dispatching an effect a resume found unknown;
- sending a completed effect again on resume instead of answering it from its receipt;
- dispatching before the admission;
- answering an unknown effect from the journal;
- completing an effect that was never dispatched;
- admitting after a failed commit;
- dispatching an admitted effect a second time (a call retry under recovery);
- erasing a completed receipt;
- finishing before every step.

A property no mutant can fail would be vacuous; a mutant no property catches is a guard the spec does not state.

## Changing the model

A change to the behavior this model states (the order of admit, dispatch and complete; what a resume does with an
unknown or completed effect; what a failed commit stops) changes `Receipts.tla`, its mutants and `Frozen.lean` in
the same pull request. A property that breaks is fixed in code, or recorded with a test that reproduces its
counterexample; it is never deleted to make a check pass.
