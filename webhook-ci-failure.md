# Webhook recovery CI failure diagnosis

**Historical diagnosis.** The native Stop and webhook-test corrections have since merged upstream as #1406 and #1401. Candidate `01970d298602d7ca9a385040778190ff4eb87e3e` includes both through its main merge. This report preserves prior-head evidence; read the current PR checks and [gate status](gate-status.md) for the new candidate.

The final-head failure is consistent with an inherited test assertion that counts delivery receipts instead of logical webhook messages. The exact correction already exists in [open PR #1401](https://github.com/Parcha-ai/agentrun/pull/1401), which changes only this test. The current CI output proves two receipts, but does not print their IDs or bodies; it does not establish that the server created two distinct notices.

## Exact failing run

- Head: `3573f4a6f4f1a68b2a1c52161b0a363d2802315f`.
- [Run 41559597077, job 125667163350](https://github.com/Parcha-ai/agentrun/actions/runs/41559597077/job/125667163350), `pi-1-2 (1.2.0, first)`.
- Job started 2026-11-03 at 01:26:19 UTC and completed with failure at 01:44:41 UTC.
- Node matrix version: 22.23.2; npm 11.21.0; the scratch compatibility leg resolves the pi family to 1.2.0.
- Installation, media/PDF tools, root build, clean consumer/reference example and all three selected workspace typechecks passed. The scratch leg's serve suite caused the failure; its subsequent midstream-resume step was skipped.

| Selected scratch suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `@parcha/pi-git-remote` | 197 | 0 | 1 |
| `@parcha/pi-transport` | 1,279 | 0 | 20 |
| `@parcha/agentrun-serve` | 739 | 1 | 0 |

The only TAP `not ok` in the actual job log was:

```text
not ok 699 - a run waiting for its person when its server dies gives no new notice from the server that adopts its process; its end does
location: packages/serve/test/webhooks.test.mjs:524:1
failureType: testCodeFailure
error: the same wait, no new notice
2 !== 1
code: ERR_ASSERTION
expected: 1
actual: 2
stack: packages/serve/test/webhooks.test.mjs:542:10
```

The individual test took 5531.005743 ms; the serve suite completed normally in 375436.270806 ms. This is an assertion failure, not a timeout, missing credential or missing executable. The GitHub job log was fetched directly and checked independently of the parent's saved excerpt.

## Why this assertion can fail with correct delivery behavior

At [webhooks.test.mjs lines 37–40](https://github.com/Parcha-ai/agentrun/blob/3573f4a6f4f1a68b2a1c52161b0a363d2802315f/packages/serve/test/webhooks.test.mjs#L37), the receiver appends to `got` as soon as it has read the request, before sending its response. The recovery test waits until `got` has one `run.needs_input` receipt and immediately kills the sender using SIGKILL at lines 531–532. There is no acknowledgment that the sender has read the response and persisted delivery.

The sender only marks delivery after awaiting the HTTP response and body cancellation, then persists its outbox. A kill between receipt and that persistence leaves the queued message pending. The next server loads the pending outbox and sends that same stored message again.

This is the implemented and documented contract:

- [webhooks.ts lines 126–134](https://github.com/Parcha-ai/agentrun/blob/3573f4a6f4f1a68b2a1c52161b0a363d2802315f/packages/serve/src/webhooks.ts#L126): logical IDs derive from run, event type and moment marker; an existing ID is not queued again.
- [webhooks.ts lines 151–152](https://github.com/Parcha-ai/agentrun/blob/3573f4a6f4f1a68b2a1c52161b0a363d2802315f/packages/serve/src/webhooks.ts#L151): pending deliveries can reach a receiver twice under the same ID when a server stops.
- [Server README](https://github.com/Parcha-ai/agentrun/blob/3573f4a6f4f1a68b2a1c52161b0a363d2802315f/packages/serve/README.md#L363): `webhook-id` is the receiver's idempotency key; pending messages survive restart and can arrive twice under the same ID.

The existing assertion at line 542 counts all receipts and requires one. That incorrectly requires exactly-once delivery across a SIGKILL. Counting distinct webhook IDs and requiring identical bodies instead preserves the intended guarantee: no new notice for the same wait, while accepting a delivery retry.

## Existing correction and corroborating evidence

[PR #1401 — test(serve): an adopted run's wait counts webhook-ids, not receipts](https://github.com/Parcha-ai/agentrun/pull/1401) was open at head `9b843648fa95a411c209276d7b862c4443ef369c` when inspected. Its base is `af473314a40a1246c5e34bb303a7e97df51b4c0f`; the initial correction commit `67b7c561b01f544c1dcf5a882fb2335e66725b44` was authored on 2026-11-02 at 21:51:12 UTC, before this console branch's first implementation commit on 2026-11-03 at 00:49:06 UTC.

The diff changes only `packages/serve/test/webhooks.test.mjs` (6 insertions, 1 deletion). It replaces the failing raw receipt-count assertion with:

```js
const waits = ofType(hook.got, "run.needs_input");
assert.equal(new Set(waits.map((r) => r.headers["webhook-id"])).size, 1, "the same wait, no new notice");
assert.ok(waits.every((r) => r.body === waits[0].body), "a try again is the same message");
```

Its [pi 1.2.0 first job 125580317884](https://github.com/Parcha-ai/agentrun/actions/runs/41533765882/job/125580317884) succeeded at that PR head. This success and the diff were independently checked via GitHub metadata; no CI rerun was requested.

The PR author reports instrumented reproductions, not independently rerun in this investigation: 22 runs receiving two receipts all had the same webhook ID and body timestamp, and all 11 logged outboxes immediately after the kill held a pending message with zero recorded attempts. This is direct supporting evidence for the documented retry window.

[Unrelated PR #1394](https://github.com/Parcha-ai/agentrun/pull/1394), head `5c100765c7e71670aa02940623a1ab00676ea964` when inspected, separately records this exact webhook recovery failure on its branch and **10/10 reproductions on plain main `f7717a119`**, with one ID received twice. This is attributed prior reproduction evidence from that PR's body, not an independently fetched failing CI trace. No separate historical failing webhook CI trace was found in the bounded prior-run checks.

## Why it is inherited

Between this PR's base `1961a96fcbbfbe89d5b5e0de9704289d2538037d` and final head `3573f4a6f4f1a68b2a1c52161b0a363d2802315f`, both relevant blobs are identical:

| File | Base and final-head blob |
| --- | --- |
| `packages/serve/src/webhooks.ts` | `d24e43e52dd7a2ef08b413230dca42af28913067` |
| `packages/serve/test/webhooks.test.mjs` | `a3b43cca60cc73aa4871966c504e4e4f50c70256` |

The run-state implementation is also unchanged. Shared `test/support.mjs` differs only by an asset-manifest write inside `builtConsole()`, which this webhook test does not invoke. This branch changes no webhook delivery or recovery behavior.

## Conclusion and limits

The strongest supported diagnosis is an inherited receipt-count test flake against an at-least-once delivery contract, with an exact, already-reviewed test-only correction in PR #1401. It is distinct from the genuine queued-status Stop race addressed by PR #1406.

The failed CI log omits receipt IDs and bodies, so those particular two receipts cannot be independently deduplicated from its output. A genuine pair of distinct IDs would still be a product defect and would also fail PR #1401's corrected assertion. No current evidence demonstrates such a defect here.

Investigation was read-only: no source changes, test executions, API mutations, reruns, commits or pushes. The correction was not applied during the original investigation. It later arrived through the candidate's normal main merge after the upstream PR merged.
