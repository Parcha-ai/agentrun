# Final-head CI diagnosis

At `23bf2743349e38461601fd6e959d6801b99df46e`, [workflow 41570207587](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587) completed **failure**. Final job-page totals observed `2026-11-03T03:25:57Z`: **70 passed, 4 failed, 0 pending**. Every failed job's actual log was fetched and read.

| Failed job | Actual cause |
|---|---|
| [test (24.21.0, examples-2)](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587/job/125701070321) | Actual test assertion: 5 carries; expected at most 4 |
| [verify (22.23.2)](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587/job/125705506351) | Downstream gate: RESULT=failure; console and Pi legs success |
| [verify (24.21.0)](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587/job/125705506363) | Downstream gate: RESULT=failure; console and Pi legs success |
| [verify (22.19.0)](https://github.com/Parcha-ai/agentrun/actions/runs/41570207587/job/125705506381) | Downstream gate: RESULT=failure; console and Pi legs success |

## Sole failing test

The examples shard completes with 162 tests: 161 passed, 1 failed, 0 canceled and 0 skipped. [The slow-tick carry test](https://github.com/Parcha-ai/agentrun/blob/23bf2743349e38461601fd6e959d6801b99df46e/examples/reference-demo-hostlines.test.mjs#L385) fails at line 395:

```text
AssertionError [ERR_ASSERTION]: carried 5 times in 19228 ms
```

This is a test assertion failure, not setup, cancellation or timeout. The assertion requires `carries <= 4`. Its original fixture uses real 7,000 ms linger and 2,500 ms transfer delays; the production tick runs every 2,000 ms while no carry is active, then performs a final carry. Total carries depend on total run duration. The observed count alone does not prove overlapping or queued transfers.

All three verify logs show only the aggregate command refusing `RESULT=failure`, with `CONSOLE=success` and `PI_LEGS=success`. They contain no independent test failure. Every other job, including the three native durable legs and Lean, passed.

## Baseline investigation

The failing test, harness demo implementation, reference fixture, reference helper and native lockfile have identical git blobs in the candidate and pinned main `0ca81bce2d7cf7db398080efe2427d296a552a4d`. A bounded historical search examined 100 completed main runs and 47 unrelated failed PR runs. Failed example-job logs found there had different assertions or compile errors; no same-cause baseline CI failure was found. This is not a claim that all historical runs were searched.

The original unchanged case was then executed from a pristine main source archive in disposable `node:24.21.0-bookworm` containers. Native workspaces built from that archive; no console build or dependency installation was performed. Shared native dependencies were mounted read-only, with identical native lockfiles. No source, test, threshold or fixture was changed, and network access was disabled.

| Constraint | Result |
|---|---|
| 2 CPUs, 4 GB memory, Node 24.21.0 | 1 passed, 0 failed; reported test duration 11,750 ms |
| 1 CPU, 4 GB memory, Node 24.21.0 | 1 passed, 0 failed; reported test duration 11,967 ms |

Both runs passed. **The failure was not reproduced; a CI environment cause or baseline-failure waiver is not established.** No candidate pair was run because baseline did not reproduce. Test bytes were verified against the original main blobs after execution. All disposable containers exited automatically and the isolated source/build archive was removed; logs and receipts remain.

## Final source/review state

Candidate `23bf2743349e38461601fd6e959d6801b99df46e` remained unchanged and the shared checkout stayed clean. All five review threads remain resolved; all seven reviews and three issue comments were fully paginated again. No new actionable reviewer request exists. Greptile's only 5/5 still explicitly reviews `3573f4a6`, so current-head review-clean is pending. No review trigger, rerun, approval, merge, PR comment or Slack message was sent.

Final main readback advanced to `c8307c987088b174a42623635753bb2e27a9ac6b` through test-only [#1416](https://github.com/Parcha-ai/agentrun/pull/1416), changing ten native test paths; only `packages/serve/test/support.mjs` overlaps this candidate. No runtime/UI code changed in that main commit. The earlier clean candidate/main trial was pinned to `0ca81bce2d7cf7db398080efe2427d296a552a4d` and is now historical for base freshness. No new-base merge or trial was initiated. The queue remains empty and approved-only #1377 remains at its recorded head.
