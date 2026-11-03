# Final-head CI failure diagnosis

Candidate `23bf2743349e38461601fd6e959d6801b99df46e`, workflow [41570207587](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587). Monitoring remains in progress; this is the first confirmed failed job, not a final workflow verdict.

## Confirmed failure

[Node 24.21.0 examples-2, job 125701070321](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587/job/125701070321) completed with failure at `2026-11-03T03:10:48Z`. Its test step ran and completed; this was not setup failure, cancellation or timeout. Its summary is **162 tests, 161 passed, 1 failed, 0 canceled, 0 skipped**.

The sole failing test is [the slow tick does not queue a carry behind one still running](https://github.com/Parcha-ai/agentrun/blob/23bf2743349e38461601fd6e959d6801b99df46e/examples/reference-demo-hostlines.test.mjs#L385). The assertion at line 395 reports:

```text
AssertionError [ERR_ASSERTION]: carried 5 times in 19228 ms
```

The assertion requires `carries <= 4`. The fixture uses a real 7,000 ms linger and a real 2,500 ms delay in each `bringHome`. The [production tick](https://github.com/Parcha-ai/agentrun/blob/23bf2743349e38461601fd6e959d6801b99df46e/packages/harness/src/demo.ts#L755) runs every 2,000 ms, calls carry only when `carryBusy` is false, and performs a final carry after the runner exits. A fixed bound on the total number of carries therefore depends on how long the whole spawned job remains running; this failure alone does not demonstrate overlapping or queued transfers.

## Base parity and limits

The failing test, `packages/harness/src/demo.ts`, `examples/reference/demo-fixture.ts` and `examples/reference-demo-helpers.mjs` have identical git blobs in main `0ca81bce2d7cf7db398080efe2427d296a552a4d` and this candidate. The candidate does not change these code paths. This establishes inherited source parity, not a passing base run or a proven environmental cause. No rerun or reproduction suite was performed during this read-only monitor.

The actionable evidence is a timing-sensitive exact-count assertion failing on the observed run. Further work should distinguish the intended no-overlap/no-backlog invariant from elapsed run length before changing an assertion or implementation. No fix is claimed or suggested solely from the failure message.
