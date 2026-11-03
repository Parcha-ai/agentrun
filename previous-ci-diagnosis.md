# Current CI diagnosis for PR #1408

All three completed durable jobs at `d9ff826df3195a2fb94530ad95d39186168341c8` fail on the same exact-key assertion. No additional failing test appears in these three logs.

| Job | ID | Started (UTC) | Completed (UTC) | Serve result |
|---|---|---|---|---|
| [test (22.19.0, durable)](https://github.com/Parcha-ai/agentrun/actions/runs/41567311645/job/125691815143) | `125691815143` | 2026-11-03T02:37:57Z | 2026-11-03T02:49:38Z | 774 passed / 1 failed |
| [test (22.23.2, durable)](https://github.com/Parcha-ai/agentrun/actions/runs/41567311645/job/125691814992) | `125691814992` | 2026-11-03T02:37:56Z | 2026-11-03T02:48:18Z | 774 passed / 1 failed |
| [test (24.21.0, durable)](https://github.com/Parcha-ai/agentrun/actions/runs/41567311645/job/125691815183) | `125691815183` | 2026-11-03T02:37:57Z | 2026-11-03T02:50:42Z | 774 passed / 1 failed |

The failing test is [GET /runs lists every agent's runs newest first, filtered by agent, revision and status, a page at a time](https://github.com/Parcha-ai/agentrun/blob/d9ff826df3195a2fb94530ad95d39186168341c8/packages/serve/test/revisions.test.mjs#L147). The assertion at line 157 compares the sorted `Object.keys` of a run summary against an exact list. The actual response has the two additive availability fields:

```diff
  error
+ files_available
  imported_from
  kind
  pending
+ result_available
  review
```

The remaining keys agree. Both Node 22 jobs report one `not ok` record, and Node 24's final failing-test summary identifies the same test and stack location. Every serve suite completes with **775 tests: 774 passed, 1 failed, 0 cancelled, 0 skipped**. In every job, the preceding pi-durable-disk suite has 987 passed, 4 skipped and 0 failed; pi-durable-agent has 396 passed and 0 failed. The failed job step is `Run node scripts/ci-shard.mjs durable` in all three.

This matches the independently reported local full-serve failure. It is an assertion mismatch caused by the new public optional `result_available` and `files_available` fields. These logs do not establish a runtime failure in availability, pagination or filtering. The root agent owns updating the expected keys while retaining the strict key comparison and meaningful availability-value assertions. Passing replacement-head tests and CI are still required; no fix result is claimed here.

Scope: the three completed jobs linked above from [workflow run 41567311645](https://github.com/Parcha-ai/agentrun/actions/runs/41567311645). Logs were read directly through GitHub's job-log API while the workflow was still running. This diagnosis does not claim other pending checks pass and does not qualify later source/main changes. No source edits, API mutations, reruns or review triggers were performed.
