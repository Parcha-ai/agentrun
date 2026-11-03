# Durable CI failure diagnosis

**Historical diagnosis.** The native Stop and webhook-test corrections have since merged upstream as #1406 and #1401. Candidate `01970d298602d7ca9a385040778190ff4eb87e3e` includes both through its main merge. This report preserves prior-head evidence; read the current PR checks and [gate status](gate-status.md) for the new candidate.

The only failure in [test (22.23.2, durable), job 125656123877](https://github.com/Parcha-ai/agentrun/actions/runs/41556175977/job/125656123877) at head `0d1fb055e1263e0bce99af1fc87bbca6415c941e` is the existing queued-status Stop race already addressed by [PR #1406](https://github.com/Parcha-ai/agentrun/pull/1406). This is not introduced by the console branch.

## Exact CI evidence

The job completed with failure on 2026-11-03 at 01:07:01 UTC. Installation, poppler/Ghostscript/ffmpeg installation and the root build succeeded. The failed step was `node scripts/ci-shard.mjs durable`.

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `@parcha/pi-durable-disk` | 987 | 0 | 4 |
| `@parcha/pi-durable-agent` | 393 | 0 | 0 |
| `@parcha/agentrun-serve` | 739 | 1 | 0 |

The only TAP `not ok` result was:

```text
not ok 638 - a follow-up after a stop that cut the turn's next request reads as the person's message, not a steer, and its turn finishes
location: packages/serve/test/stop-follow-up.test.mjs:11:1
failureType: testCodeFailure
error: {"stopped":false,"status":"queued","state":"working"}
false !== true
code: ERR_ASSERTION
stack: packages/serve/test/stop-follow-up.test.mjs:22:10
```

The test took 8654.221164 ms and the serve suite finished normally in 335460.988744 ms. This was an assertion failure, not a test timeout, missing executable, missing credential or build failure. The same head's Node 22.19.0 and Node 24.21.0 durable jobs succeeded.

## Cause

The faux model signals that the request after a write has started. The test then asks the server to stop the turn and expects `stopped: true`. The server's timeline can still lag behind the live process. `statusOf()` in `packages/serve/src/runs.ts:309` reports `queued`/`working` while the first submitted message has not appeared in the server's rows, and the same status occurs with no rows at line 312. `Runs.stop()` at lines 1321–1325 refuses a run unless it already reads `working`/`working`, also refusing while `run.submitted > 0`. The result is the observed `stopped: false` even though the process has reached its next request.

PR #1406, open at head `f5d12649e9599f1b462b93e803b724ddfc5b6c65` when inspected, adds a bounded wait until the rows catch up before evaluating the existing stop path. Its deterministic queued-start regression targets this same window. No fix from that PR is included in the investigated head.

## Evidence that it predates this branch

The [earlier Node 22.23.2 durable job 125572838900](https://github.com/Parcha-ai/agentrun/actions/runs/41531578652/job/125572838900), head `9cc6758a567d13bbec5df1674e4a3f837bf3be49`, independently shows the identical failing test, line 22 assertion, and `stopped:false,status:queued,state:working` response. This earlier run is listed in PR #1406 as the PR #1399 merge-queue failure. Its failure was confirmed by reading the job's actual log rather than relying only on the PR description.

Between PR #1408's base `1961a96fcbbfbe89d5b5e0de9704289d2538037d` and investigated head `0d1fb055e1263e0bce99af1fc87bbca6415c941e`, these Git blobs are unchanged:

| File | Base and head blob |
| --- | --- |
| `packages/serve/src/runs.ts` | `3f7c2b2c0d23feec245628cabf2fd1be11b6d411` |
| `packages/serve/test/stop-follow-up.test.mjs` | `3f64a309ea5c7b5f185480830c0c38f61b7261f1` |
| `scripts/ci-shard.mjs` | `eb451a8214788a4042f62a59925b87f40fb73216` |

The only changed line in shared `packages/serve/test/support.mjs` writes an asset manifest inside `builtConsole()`. The failing test calls `serve()`, `scratch()`, `startRun()` and `follow()` and never calls `builtConsole()`. Those helpers are unchanged. The workflow's only change adds an OpenAPI console contract check restricted to the `checks` shard, skipped in this durable job.

## Scope of this investigation

Read-only inspection of GitHub job metadata/logs, PR metadata/diff and local base/head blobs. No source edits, builds, CI reruns, commits or pushes. No local reproduction was needed to identify the CI signature. The diagnosis does not claim that all other CI jobs passed; it covers the requested durable job and its two matching matrix siblings.
