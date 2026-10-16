---
packages: @parcha/pi-agent-learn
kind: feature
---
New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
`@parcha/pi-git-remote`. `agentLearn()` is a pi-durable extension with one tool, `learn({ type, text, evidence?, id? })`
(a lesson, a fact, a correction, a `used` mark on a learning that helped, or a `workflow` note on when to use a workflow
the run saved), which stores one candidate per call id in the run's store, is replay safe and makes no model call, and the `<learned>`
prompt section: the rules win, the active learnings at the commit the run was seeded from (most used first, at most
4,096 bytes, with the count of those that did not fit), the workflows to try, and when to call `learn`. `seedLearning()`
is the host step at run start: it resolves a ref, records `learn.seed` (the sha and the derived index) in the run's store
once, and copies the active learnings into the run's working directory. One learning is one file
(`learnings/<id>.md`, frontmatter then the rule; `renderLearning`, `parseLearning`, `learningId`), and `agent.json` and
`AGENTS.md` are locked against every writer (`RULES_LOCKED`, `isRulesLocked`). `Guard`, `Candidate` and `WorkflowHint`
fix the contract for the guard, proposing and workflow trials that come next. Its pi-durable and chord peers accept 1.1
to 1.3.x.

`guard` is the structural check every writer runs before anything reaches git (`createGuard` sets its caps). It refuses and
never redacts, makes no model call, and never repeats a value it refused. It finds a host secret as written, split over
lines, as base64 or base64url at any alignment, as hex in either case, and percent or form encoded; secret shapes (cloud
keys, private-key blocks, tokens, a URL with a password); invisible and bidirectional characters, with emoji sequences and
the joiners of scripts that need them allowed; any value from the run's input (case data); each role's own paths (a run
writes its inbox, uses and workflow-record files, the curator writes learnings, skill folders and the workflow store; `AGENTS.md`, `agent.json`
and any `.git` segment never, in any spelling); and size and count caps. `proposeLearning` is the host step at a run's
terminal: it collects the run's candidates, renders `inbox/<run id>.md`, adds the DSL's saved workflow records the host
collected (`inbox/<run id>/workflows/<name>/`), guards the whole proposal, and makes one commit on
`runs/<run id>` through `@parcha/pi-git-remote`, pushed by sha. A guard hit refuses all of it and commits nothing; a second
call, including one from a restarted host with an empty local repository, commits nothing. `renderInbox` and `parseInbox`
are the inbox's format: the run, the commit it was seeded from (`seed`, from its `learn.seed` record) and, on each candidate,
an `untrusted` mark that `proposeLearning({ untrusted: true })` sets when the run read untrusted content.

`curate({ repo, runs, judge, rules, thresholds, caps, now, secrets, admitWorkflow, settleUses })` is the host step that writes `main`, and
the only one. It takes each `runs/<run id>` branch (read from `runs` when the host keeps run branches in another
repository) whose run no `Curated-Run` trailer on main names, guards everything
the run changed again, and judges each candidate with the DSL's System One port (`WorkflowDeps["runJudge"]`; Jev is one),
one question at a time over the candidate's own text: general or about this case, contradicts or narrows a rule in
AGENTS.md, an instruction from content the run read (for a candidate marked `untrusted`), then duplicate, supersedes and
contradicts against each active learning of its type. An answer between the cuts in `thresholds` holds the candidate;
nothing uncertain is accepted. It writes new learnings, marks replaced ones `superseded` with `supersededBy`, counts
duplicates and `used` marks as uses, hands proposed workflows to an `admitWorkflow` hook and a run's workflow uses
to a `settleUses` hook (both ports are this package's types), archives the least-used learnings when the
derived `<learned>` section would pass 4,096 bytes, and makes one commit per run on main with `Curated-Run` and
`Learning-Id` trailers, pushed without force and rebuilt on a moved main at most five more times (then `contended`). A
reverted learning stays reverted, a second curate changes nothing, and no reason in the report or a commit message names
a value from the case. A learning's `provenance.sha` is the inbox's `seed`; without one it is the run branch's base and
`provenance.shaFrom` says `branch-base`. Learning files take an optional `supersededBy`.
`retireLearning({ repo, id, reason })` takes a learning out after it was used, where a `git revert` of the commit that
added it would conflict: one commit on main sets its status to the new `retired` (the file stays), with a
`Retired-Learning` trailer, pushed like a curate commit. A retired learning never shows in `<learned>` again, and curate
holds a run that learns it again in other words.
