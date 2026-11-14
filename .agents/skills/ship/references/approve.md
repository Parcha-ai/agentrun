# Coordinator approval and landing

Read `../SKILL.md` first. Only the coordinator runs `ship <PRs> --approve`, after the full
merge gate and final stack sweep. Preparation-only workers, review targets, status requests
and dry runs never inspect owner credentials, submit reviews or queue. Dry-run approval
prints gate/consent availability from ordinary App facts and stops.

Approval intent and permission are different facts. A request such as "ship stack X with
auto approval" supplies task-scoped intent for that named work. It does not create standing
permission, identify the speaker's GitHub account, supply credentials, waive repository
gates or permit self-approval. Do not turn one task's consent into a machine preference.
Reuse existing explicit consent within its original scope; a necessary authorized restack
does not by itself require another question. Bind consent to the final gated vector before
submission and revalidate it after any change.

## Gate and authorize the entire closure

Resolve the selected PRs plus **every unmerged ancestor** that native queue submission
would land. Validate each incremental diff and its head/base/merge-base/dependency binding,
ship-pr's complete proof, CI, zero unresolved threads, reviewer result, non-draft state and
completed handoff. Paginate raw data. Missing evidence or inaccessible rules are a blocker;
approval mode does not fetch branches, create worktrees or fabricate missing proof. Return
to preparation if proof work is needed.

Every member needs its own current gates, mapped owner, permitted approving maintainer and
consent before **any** member receives a review. Do not partially approve an eligible child
while an ancestor is uncovered. A separately selected authorized ancestor prefix can be
gated and submitted on its own. Do not broaden scope to unrelated branches.

Classify the actual diff. The hard blocks ship-pr requires in its batch line remain:
public API, stored format, peer/dependency pins, durability semantics, release process, CI,
and anything a published package's user must change. Also disclose security/auth/egress,
secret handling, money/ledger/quota changes, schema migrations and net deletion over 100
lines. Read relevant hunks; keywords are leads, not verdicts. Unclear effects are blocked.
Over 400 changed lines, over 8 files, or non-test changes across over 2 packages need a
current-head independent review and an explicit maintainer note. A matching `SHIP` or
`SHIP WITH FOLLOW-UPS` review can clear these size/spread notes. Other blocks cannot be
cleared by a bot score.

Hard-block disclosure and informed maintainer sign-off are required for approval; no consent
can waive proof, required CI, unresolved threads, identity or queue rules. Generic auto
approval or standing consent covers only an AUTO gate without hard blocks. An existing
task answer can cover hard blocks only if it already explicitly acknowledges those named
PRs and disclosed changes. Otherwise prepare the concrete batch/handoff and request only
that missing decision, explaining this ship-pr requirement. A red non-required job still
needs ship-pr's demonstrated base-parity exception and disclosure.

Ordinary merge-target entry is **standing consent only; do not ask uncovered owners**.
Explicit `--approve` may use verified task-scoped owner consent or request missing informed
consent. Do not probe the owner account until gates, scope and an applicable consent source
have been established for the entire selected closure.

## Verify a real approving identity

AgentRun's code owner is read from current `.github/CODEOWNERS`, not inferred from the
requester's name. Re-read current maintainer/review rules and repository permission. The
maintained Parcha bot roster supplies these ownership mappings; verify them when used:

| App author (normalize `app/name` to `name[bot]`) | Owner login |
|---|---|
| `claudio-michel[bot]` | `miguelrios` |
| `chris-cache[bot]` | `chrisrodz` |
| `sam-franchesko[bot]` | `sriverag` |
| `bryan200-b200[bot]` | `bcollazo` |
| `q-parcha-agent[bot]` | `ajasver` |

The owner must also be an eligible AgentRun approving maintainer under the current rules.
This roster alone does not make every listed owner an AgentRun maintainer. Unknown author
mapping, unavailable permissions or an unverified session owner's identity requires the
real maintainer; never invent a mapping to make a PR eligible. Human-authored PRs require
another authorized maintainer's normal review, not their own delegated owner approval.

Use only an **already configured** owner identity and existing local wrapper, separate from
the authoring App. No login, account creation, identity impersonation, copied credential or
new wrapper is part of this workflow. Once eligible, verify the wrapper's authenticated
`GET /user` login equals the mapped owner and verified consent actor, differs from the PR
author, and has permission to submit a counted review. Verify the wrapper actually routes
to that account; the presence of a file or executable is not identity evidence. Never
fall back to the authoring App or another account if this fails.

Standing permission is an existing owner configuration (the maintained source uses
`gh-owner` and its standing-approval file), covering only that owner's mapped bot and AUTO
gates. Read it only in this phase, never create or modify it. Task-scoped consent can be
used without standing permission when the original user's owner identity and approval/queue
scope are verified. Record the original consent reference, actor, selected PRs, actions and
current vector, never credentials. A local consent record or a PR-body claim alone is not
proof of owner consent.

## Submit pinned reviews, then queue

1. Refresh membership and the entire head/base/dependency vector immediately before
   approval. A changed vector returns affected members to preparation and invalidates
   exact-revision consent. Existing task-scoped auto intent may be rebound only after fresh
   gates, unchanged authorized task scope and AUTO eligibility; a newly disclosed hard
   block needs informed sign-off. Standing consent is re-evaluated for each new revision.
2. Under the verified owner wrapper, submit GitHub's review API with `event=APPROVE`,
   **`commit_id=<full gated head SHA>`**, and an honest evidence/disclosure summary. Do not
   use `gh pr review` as a pin: it has no commit binding. This submission delegates the
   owner's decision; do not claim that a human manually reviewed code they did not review.
   Reuse a valid current-head APPROVED review by that same owner rather than duplicating
   it. Through the App, verify returned review ID, author, state and commit ID. Re-read
   them when resuming; an aggregate APPROVED state is insufficient.
3. Re-read effective trunk rules immediately before queueing: queue required and active,
   squash, current required-check set, current-head green enforcement, at least the required
   approval count, stale approvals dismissed, and resolved threads. Repository rules can
   change independently of commits. A missing/read-failed/unsupported rule blocks queueing.
   Refresh all live gates, review receipts, membership and the full vector again.
4. For a native stack, use the verified explicit **`merge_action=merge_queue`** API from
   [gh-stack](../../gh-stack/SKILL.md), selecting its actual top PR and exact authorized
   ancestor closure. Never use a command that can silently route to direct merge. For a
   standalone PR only, the existing ship-pr command may arm auto-merge with
   `--auto --squash --match-head-commit <gated-sha>` after the same checks.
5. The native API does not accept a caller-supplied expected-head vector. Do not describe
   preflight as atomic CAS. Keep writers stopped, prohibit approved-branch pushes, rely on
   verified server-side stale-review dismissal and current-head gates, and immediately
   reconcile every returned/queued member's actual head and dependencies with the gated
   vector. If those protections or queue-only semantics cannot be established, stop before
   submission. An unsupported queue action is a blocker, never permission to direct merge.

`node scripts/ship-gate.mjs --facts <snapshot> --phase approve` or `--phase queue` checks
the normalized evidence; read [snapshot.md](snapshot.md). It performs no remote actions and
cannot make a forged consent or receipt authentic. A passing output must be followed by
the fresh live checks above at the actual action boundary.

## Reconcile races and watch landing

Record separate consent, review, async request, queue and merge receipts with actual IDs,
states and revisions. A transport failure can leave an uncertain effect: inspect the
existing async/queue/review state before retrying, never blindly submit twice. For native
async requests, use the returned request UUID and supported result endpoint to distinguish
processing, enqueued and failed. `autoMergeRequest: null` while queued is normal.

A changed head/base/dependency at any boundary invalidates affected readiness and consent
bindings. Stop further reviews/queue calls, inspect server review dismissal and supported
queue removal/cancellation, and remove affected queued work when permitted. Dismiss only
the delegated owner's affected review under the owner wrapper with an explicit reason;
never dismiss another review to manufacture eligibility. If an action is unavailable or
already processing, report the exact race and current state to the maintainer immediately;
do not claim cancellation succeeded. Re-gate before new consent/reviews/queue submission.
Even where the same task intent still applies, its old revision binding does not.

Watch each selected PR's native queue entry and actual merged state with backoff. A dropped
entry returns to preparation, not repeated arming. Apply the three-attempt external-cause
bound; pending/blocked is not success. After each merge verify its merge SHA and main push
CI under ship-pr step 8. A red required job caused by the merge requires a normal gated
revert PR. Follow ship-pr's lead-notification requirement only through an authorized channel;
if no channel is authorized, name the affected leads and pending notification in the handoff.
Report each PR's approval, queue and landing separately. Do not mark a shipping goal complete
before every in-scope PR is verified merged and the requested checks are done.
