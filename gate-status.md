# Console validation and remaining gates

Candidate: `3573f4a6`. This is a review handoff, not a merge-ready verdict.

| Proof | Result |
|---|---|
| Automated review | PASS, exact-head Greptile 5/5; all 5 threads answered and resolved in 2 iterations. [Review report](review-report.md). |
| Console typecheck and full suite | PASS, 385 tests in 45 files. |
| Live browser | PASS, 27 checkpoints across 9 scoped rows, including actual audio/video playback, byte-exact downloads and a slow expanded refresh across the polling interval. |
| Public client against actual server/run processes | PASS, 8 test results, including revisions, input, idempotency, files and restart. |
| Affected native server suites | PASS, 69 tests. Native source is unchanged after this run; the final UI-only polling change was rebuilt and tested separately. |
| Strict installed UI consumer | PASS, Bundler and NodeNext with skipLibCheck disabled, Node ESM/client execution, portable declarations and notices. Final archive SHA-256: `65998e5ec0c5f1761f7713d54ba0fb89d046d554737534d71bc4197d809a33db`. |
| Generated contracts, schema, author references, source inventory and changelog | PASS. |
| Native package verification | PASS at `3d83a3f6`, all 17 packages. The final change affects only Mission polling and its Refresh control; final container proof separately checks the rebuilt assets. |
| Release checks | PASS, 416 tests. |
| Examples | PASS, 599 passed and 5 skipped. |
| Viewer | PASS, 403 passed and 5 skipped. |

The earlier clean public-source build, Storybook build and 26 packaging guard tests passed. Publication holds remain intact. No registry release, hosted deployment or customer migration occurred.

## Full repository result

The full `npm run check` is not claimed green. Its build, generated checks and typechecks passed. All workspace suites except the native server passed. The initial local server run passed 730 of 740 tests and exposed:

- Four document cases requiring Ghostscript. The entire 14-case document suite passed in a disposable container with Ghostscript, Poppler and ffmpeg.
- Five cases whose no-credential assumptions conflict with credentials inherited by the host process. All 32 cases in the affected API, harness and runnable files passed in a disposable environment with no credentials and the pinned SDK development dependencies.
- The existing queued-status Stop race at `stop-follow-up.test.mjs:22`. An independently compiled copy of unchanged main reproduced the same `stopped:false,status:queued,state:working` failure. The same failure appears in earlier unrelated CI.

[CI diagnosis and prior-head evidence](ci-failure.md) records that race. [Approved PR #1406](https://github.com/Parcha-ai/agentrun/pull/1406) contains its fix. Integrate that dependency before treating the full gate as green. Current-head CI and review status must be read from the PR, rather than inferred from this static receipt.

## Dependencies and queued work

The console lockfile retains 14 inherited audit findings: 7 moderate, 3 high and 4 critical. The added contract generator introduces none. No dependency remediation is claimed. Native package verification uses the repository's existing audit exceptions; the next high-severity exception expiry is November 6, 2026.

The [stack trial](stack-trial.md) inspected all 12 approved and queued PRs. The candidate is clean against the inspected main. Applying it after queued #1400 conflicts in App.tsx; the report records the intended reconciliation. Three other overlapping PRs merge cleanly. The combined queue also has an unrelated README conflict before this candidate enters it.

Maintainer approval and a refreshed merge gate remain required.
