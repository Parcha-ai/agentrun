---
name: gh-stack
description: "Manage AgentRun's native GitHub PR stacks with gh-stack: inspect, restack, publish and coordinate gated queue submission. Use for dependent PR chains and native stack operations."
---

# Native PR stacks

Use GitHub's native stack membership and actual PR base refs as authority. A stack comment
is not native membership. This framework is adapted from the maintained
[Parcha gh-stack skill at 37fc1a0a24d374abda3c136a36b6d5998c9ff1ea](https://github.com/Parcha-ai/parcha/blob/37fc1a0a24d374abda3c136a36b6d5998c9ff1ea/.agents/skills/gh-stack/SKILL.md),
whose upstream metadata names github/gh-stack v0.1.0. Verify the installed CLI's version,
help and implementation for the operation; the command's side effects vary by version.
Use [ship](../ship/SKILL.md) for proof, approval and landing policy.

## Inspect and own

Read native membership, dependency order, trunk, each full head/base/merge-base and state.
Resolve a bare number as the installed CLI does: v0.1.0 tries stack number before PR number.
Confirm the command selects exactly the authorized PRs and their unmerged ancestors.
Merged ancestors are historical members, not work to recreate. Closed unmerged members
need an explicit resolution, never silent removal. More than one parent/child or ambiguous
membership is a graph problem to resolve before mutation.

The coordinator owns stack-wide changes and native membership. Workers own one PR and one
isolated worktree, use `ship <PR> --to merge --prepare-only`, and report inherited defects
at their first owning layer. Do not switch checkouts under running tests or previews, erase
another stack's tracking, or alter another writer's branch. Preserve unrelated dirty work.

Always supply arguments/flags needed for non-interactive operation:

| Operation | Shape and material side effects |
|---|---|
| Inspect | `gh stack view --json`; v0.1.0 requires a locally tracked checkout, not a stack-number positional argument. Use read-only API discovery if tracking is absent |
| Checkout | `gh stack checkout <stack-or-PR-number>` fetches branches and creates local tracking; never run for a dry run |
| Rebase | `gh stack rebase` cascades; inspect help for `--continue`, `--abort`, `--upstack`, `--downstack`, `--no-trunk`. Never assume it is local-only without verifying the version |
| Push | `gh stack push` uses explicit per-branch leases but is non-atomic in v0.1.0; verify every remote after partial rejection |
| Submit | `gh stack submit --auto` pushes and creates/updates PRs and native membership; add `--open` only with readiness authorization |
| Link | `gh stack link <bottom> <child> ...` may push branches, create PRs and correct bases; it is a mutation, not discovery |
| Sync | `gh stack sync` combines fetch, rebase, push and metadata updates; avoid when validation must happen before publication |
| Unstack | A remote/grouping mutation unless explicitly `--local`; neither is a routine fix for another writer's tracking |

Do not install/update extensions or change persistent git configuration just to silence a
prompt. With multiple remotes, use supported `--remote` flags or existing configuration.
Avoid interactive `view`, checkout without an argument or submit without `--auto`.

## Restack and verify

Pause affected writers and record before refs and expected remote SHAs. Confirm ownership
and clean/coordinated worktrees. Use the native conflict workflow where it can prepare
locally; otherwise prepare the same branch chain with git in owned worktrees, preserving
PRs and native membership. Respect ship-pr's rule against pushing an approved PR: such a
revision returns to its maintainer for a new approval rather than silently discarding it.

Resolve from trunk upward. Read every file edited by both sides even on a clean textual
rebase; check moved functions, test patch targets, duplicate helpers, generated files,
dependency pins and model changes. Run affected tests against the actual combined result
before any push and then each layer's full ship gate. A green top layer does not validate
an invalid intermediate package split. Fix the earliest owning layer once and propagate it.

Publish only authorized branches with explicit expected-SHA leases. A rejected lease means
reconcile remote changes, never overwrite. Preserve already published partial results and
re-read all remote refs before retry. Verify the native group, base refs, full remote SHAs
and conflict state after publication. Invalidate affected gates and descendants, including
when a lower member merges during the restack. Return current vectors to workers.

## Queue submission

Only the coordinator, after ship's complete approval flow, submits the gated ancestor
closure. `gh pr merge` is not the native stack queue operation. Do not use `--admin`, a
bypass, direct merge or a queue-less fallback.

The v0.1.0 shape `gh stack merge <target> --yes --squash` can merge directly if no queue is
detected. Its implementation also treats a queue-detection query error as false. Help text
and a prior ruleset read therefore do **not** make that command a safe queue-only call.
For AgentRun, use the same native stack API with an explicit queue action only after
verifying current supported semantics and repository rules:

```sh
gh api repos/Parcha-ai/agentrun/pulls/<top-PR-number>/merge-async --method PUT \
  -f merge_action=merge_queue
```

`<top-PR-number>` is the actual selected PR number, not an ambiguously resolved stack ID.
In github/gh-stack v0.1.0 the API forces queue routing and rejects the queue action when
there is no queue. The queue chooses its configured merge method. Source evidence:
[MergeStackAsync](https://github.com/github/gh-stack/blob/v0.1.0/internal/github/merge_async.go)
and [queue detection/action selection](https://github.com/github/gh-stack/blob/v0.1.0/cmd/merge.go).
Re-verify this capability for the installed/API version; unsupported or unverified action
blocks submission. Never probe it with a mutating request before approval.

The request has no caller-supplied expected-head vector: do not invent a CAS guarantee.
Ship's approval flow binds reviews with `commit_id`, revalidates membership and the full
vector immediately before this request, requires stale-approval dismissal and current-head
CI in live rules, prohibits author pushes after approval, and reconciles resulting queue
heads. A changed revision requires fresh gates and consent. A transport timeout is an
uncertain submission: inspect native queue/async state before retrying. A `pending` result
is processing; `enqueued` is queued, not merged. Watch each PR through actual landing and
the main push CI as ship-pr requires.
