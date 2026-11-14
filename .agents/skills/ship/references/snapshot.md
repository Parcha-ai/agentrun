# Snapshot contract

`scripts/ship-gate.mjs` is a read-only decision helper, not a GitHub client or an evidence
attestor. The coordinator constructs its JSON input from live API results and verified
proof/consent receipts. Keep raw responses and source references in ignored evidence, never
credentials. Fabricating `verified`, `pass`, `counts` or `source` fields defeats the contract.
The helper does not interpret the diff, determine whether a review counts, or authenticate
the user. Those judgments require the original artifacts and current repository policy.

Use Node at the repository's floor. The CLI prints JSON, exits 0 for the requested phase's
passing classification, and exits 1 for a blocker/invalid input. It never edits its input,
calls a subprocess/network or reads owner configuration. No output claims an effect happened.

```sh
node scripts/ship-gate.mjs --facts .evidence/ship/snapshot.json --phase prepare
node scripts/ship-gate.mjs --facts .evidence/ship/snapshot.json --phase approve --dry-run
```

`--phase` is `prepare`, `approve` or `queue`; `--role worker` and `--prepare-only` prevent
approval/queue phases. `--dry-run` only classifies ordinary gates and returns `inspect`,
without consuming consent or owner identities. An ordinary preparation result is `handoff`,
not approval. Approval/queue results are `approval-eligible`/`queue-eligible`, never receipts.
Only `ownerProbeAllowed: true` permits moving to an existing-owner identity probe after all
closure gates and consent have passed; `ready` remains false until identity is verified.
All-selected-already-merged yields `complete` with no owner probe or queue action.

Top-level fields:

| Field | Source and shape |
|---|---|
| `repository` | Exactly `Parcha-ai/agentrun` |
| `trunk` | `{ref, sha}` with a full 40-hex SHA |
| `stack` | Native `{id, members: [PR numbers bottom to top], source}`; absent only for a standalone PR |
| `selected` | Requested PR numbers; the helper derives the unmerged ancestor closure |
| `scope` | `{prs: [authorized PR numbers], source: original user instruction reference}`; selecting a child alone does not authorize ancestors |
| `rules` | Current effective trunk rules, including inherited rulesets, read with sufficient permissions |
| `prs` | PR facts/receipts below, including all ancestors needed to verify membership |
| `consents` | Approval phase only: one scoped original owner authorization per closure member |
| `maintainers` | Approval phase: `{login, eligible: true, source}` from current code-owner/review policy and repository permissions |
| `identities` | Only after permitted owner probing: `{login, existing: true, canReview: true, source}` from the existing wrapper's authenticated user and permissions |

`rules` has `verified: true`, `source`, `ref`, nonempty `requiredChecks: [context names]`,
and `requiredCheckApps: {context: appId}` when rules bind the check to an App. Queue phase
also requires `queueRequired: true`, `queueMethod: "SQUASH"`, `currentHeadGreen: true`,
`staleApprovalsDismissed: true`, `threadsRequired: true` and `approvalCount` at least one.
For native stacks, `nativeQueueAction: {supported: true, action: "merge_queue", source}`
records verified current API support, not a guessed capability or a mutating probe. These
booleans summarize actual active rules: do not infer them from defaults or an old skill.

Each PR has `number`, `state: "OPEN"|"MERGED"|"CLOSED"`, `author`, `headRef`, full `head`,
`baseRef`, full `baseSha`, full `mergeBase`, `parent` (PR number or null), a verified
`parentIsAncestor: true`, `isDraft: false`, `mergeable: "MERGEABLE"`, and numeric
`unresolvedThreads: 0`. `parentIsAncestor` verifies the active unmerged PR parent; with no
active parent (`parent: null`) it is vacuously true, not evidence that current trunk is an
ancestor. `baseSha` is the resolved live base-ref target (`baseRef.target.oid`); GitHub's
stored PR `baseRefOid` can lag and must be retained separately. Preserve actual trunk
ancestry, merge base and the fresh-base assessment as distinct raw facts. For a merged
parent the live child must already target the new trunk; an old parent receipt is not
silently carried forward.

`gate.binding` is the immutable object returned by `bindingFor(snapshot, number)` when the
proof was actually established. It contains repository, native stack ID, trunk ref/SHA,
the PR's `{number, head, baseRef, baseSha, mergeBase}` and the ordered unmerged dependency
revisions. Serialize it with the evidence at gate time. Do not regenerate it during a status
check to conceal stale evidence. `gate` also has `local`, `proof`, `description`, `review`,
`threads`, `stackTrial` and `handoff`, each `{status: "pass", source}`. These refer to all
applicable ship-pr requirements, including main-model proofs and applicable package/live
checks, not just a sample passing command. The handoff must be complete and head-bound.

`classification: {source, hardBlocks: [disclosed categories], softBlocks: [size/spread]}`
records the actual diff assessment under `approve.md`; missing classification blocks.
Size/spread can be cleared with `independentReview: {head, independent: true, source,
verdict: "SHIP"|"SHIP WITH FOLLOW-UPS"}`. Hard blocks need informed maintainer consent and
cannot be cleared this way.

`ci: {source, checks: [...]}` contains the applicable check runs **and commit statuses**,
each with `name`, `head`, `status: "completed"`, `conclusion: "success"`, and `source`.
Include `appId` when required by a ruleset. Preserve raw run IDs, trigger event, workflow,
PR/base context and attempts: a commit-wide rollup can include old cancelled attempts.
Do not blanket-dismiss failed or cancelled runs. A result can be superseded only by a
newer result in the exact same context. The helper can establish this when both records
carry `workflow`, numeric `appId`, `event: "pull_request"`, matching `pr`, matching
`baseRef`, numeric `runId` and numeric `attempt`; it selects the higher run ID, then higher
attempt. Without those complete identities every supplied result is evaluated. A newer
failure still blocks. Different workflows, Apps, events or PR/base contexts cannot excuse
one another. Classify truly inapplicable raw runs with evidence before building this input;
retain excluded raw run IDs and reasons beside the snapshot. An old-base pass cannot prove
the current base. Never hide an actual latest applicable failure.

For a legitimate workflow/path-filter skip, `ci.skips` contains `{name, head, source,
reason, mergeGroup: true}`, after verifying the workflow's trigger and queue coverage.
`ci.exceptions` is only for demonstrated **non-required** base-parity failures:
`{name, head, run, check, baseRun, cause}`. `run` must equal the failed check's exact `source`.
`check` must exactly match that check's immutable identity: positive numeric `checkId`,
`runId`, `attempt`, `appId` and `pr`, plus `workflow`, `event` and `baseRef`. Put those
identity fields on the check itself too. Missing identities or mismatched check/run IDs,
attempts, Apps, workflows or contexts block the exception, even on the same head and name.
Keep the separate authenticated `baseRun` and shared-cause evidence; matching an identity
does not prove base parity. Disclose each exception in the batch/handoff. Required red/pending
checks cannot be exempted, and absent required checks cannot simply disappear.

Approval-phase `consents` entries have `{pr, kind: "task"|"standing", actor,
actorVerified: true, repository, actions: ["approve", "queue"], source, binding}`. Verify
the original source, actual owner actor and authorized actions; copying the source string
is not verification. `binding` captures the exact final gated revision. Existing task-scoped
auto intent can be rebound only under `approve.md`; exact-revision consent cannot. Standing
consent additionally requires `ownerConfigured: true`. Informed task consent names any
hard blocks in `acknowledgedBlocks: [...]`. Generic task auto consent leaves that absent.

Queue-phase PR `reviews` contain `{author, state: "APPROVED", head, counts: true, source}`
from actual GitHub review IDs and policy. At least the mapped owner's current-head counted
review and the rule's required distinct approver count must be present. An aggregate review
decision is not a substitute. Reconcile live revisions and rules immediately before acting,
then record real review/queue/merge outcomes separately; a helper result never proves them.
