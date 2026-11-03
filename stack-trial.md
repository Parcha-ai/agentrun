# PR #1408 current read-only stack trial

Pinned candidate `23bf2743349e38461601fd6e959d6801b99df46e` and fresh main `0ca81bce2d7cf7db398080efe2427d296a552a4d`. Snapshot `2026-11-03T03:07:17.689652+00:00`. This is a merge-plumbing trial, not runtime qualification, approval or a merge.

- Fully paginated snapshot: 27 open PRs, 1 approved PR, 0 queued PRs. All selected heads and complete file lists were fetched.
- Candidate changes 87 paths. Main is already contained; 0 unintegrated main commits. Candidate/main trial exits 0 with tree `5090971ec9092cf4becec1fc5ccf5ae3d702e7f4`.
- Final readback confirms main, candidate head, all selected heads, approved set, queue order, checkout head and tracked status unchanged.
- The earlier #1405 packaging conflicts are resolved in the normal main merge; native serve/decisions publication policy is retained and the UI library remains private. Prior #1400 and upload README conflicts are also resolved. Previous trial reports were preserved as historical artifacts.

## Every approved or queued PR

| Queue/status | PR | Head | PR files/shared paths | Earlier PR against main | Candidate after earlier PR |
|---|---|---|---|---|---|
| Approved, not queued | [#1377](https://github.com/Parcha-ai/agentrun/pull/1377) feat(serve): a saved monid key works on every harness, only in the runs that name it, with its charges in the run's cost and cap | `51c4908701a0fb163aea0d1dfae0494bf3cb191b` | 32 / 4 | CONFLICT (11 paths) | Not constructible: earlier PR already conflicts |

## Partial overlaps and genuine upstream conflicts

**#1377 shared paths:** `packages/serve/README.md`, `packages/serve/src/openapi.ts`, `packages/serve/src/runs.ts`, `packages/serve/src/server.ts`.

Its independent trial against main exits 1, before the candidate is applied. Conflict tree `5c4472ceae9a3972cef0b2a1aabde1b39663f5ab`. Actual conflict paths:

- `packages/pi-durable-agent/src/timeline/index.ts`
- `packages/pi-durable-agent/src/timeline/timeline.ts`
- `packages/serve/README.md`
- `packages/serve/src/host-tools.ts`
- `packages/serve/src/runs.ts`
- `packages/serve/src/server.ts`
- `packages/serve/src/tool-keys.ts`
- `packages/serve/test/fixtures/faux-model.mjs`
- `packages/serve/test/host-tools.test.mjs`
- `packages/serve/test/import.test.mjs`
- `packages/serve/test/tool-keys.test.mjs`

This is an upstream integration conflict, not a current-main conflict in PR #1408. The direct candidate/earlier-head trial is also recorded, but does not remove the earlier PR’s base conflict. No intended behavior was discarded and no unmerged code was copied.

## Combined queue and approved trial

The queue is empty, so there are no queued heads to apply. The candidate against this empty queue/main is clean.

The all-approved combined trial stops at #1377 before the candidate. Appending the candidate to the preceding clean prefix exits 0. No clean all-approved stack is claimed.

`git merge-tree --write-tree` supplied each actual clean/conflict result; clean earlier results were joined with unreferenced `git commit-tree` objects. No checkout, source, index, branch, push, PR or review change was made by this audit.
