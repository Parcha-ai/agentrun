---
packages: @parcha/pi-agent-learn
kind: feature
---
New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
`@parcha/pi-git-remote`. `agentLearn()` is a pi-durable extension with one tool, `learn({ type, text, evidence?, id? })`,
which stores one candidate per call id in the run's store, is replay safe and makes no model call, and the `<learned>`
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
are the inbox's format.

Saved workflows are tried and promoted on receipts. `admitWorkflow` is curate's hook for a workflow candidate a run saved with the
DSL's `agentrun` tool: it validates the run's records through the DSL's public store (`@parcha/agentrun-pi/workflows`), refuses a
workflow with code in it unless the host admits it, saves the revision into the checkout through the store, and writes the skill
(`.agents/skills/<name>/SKILL.md`, whose description is the `workflow` learning's text) and `trial.json`: `{ name, status, when,
revisions, uses }`, where `when` is typed checks on the run's input (a JSON pointer and `eq`, `in`, `exists`, `gte` or `lte`, derived from
the workflow's own input schema unless the host gives them). `collectWorkflows` and `inboxWorkflowFiles` hand a run's new revisions to
its inbox, `collectUses` reads from the run's store (read only, through `recordingLines`; or from the receipts of a pi session with `readSessionUses`)
which saved workflow each durable workflow task ran and whether it finished `frozen`, `escalated` or `failed`, and `settleWorkflowUses` folds those uses into `trial.json` by the rules
of the archived harness: a trial is promoted after 3 clean uses in a row, the live revision is demoted after 2 failed or escalated
ones and the previous active revision comes back, a demoted revision is never tried again, and the run that wrote a revision is no
evidence for it. `workflowsToTry` lists the trial and active workflows whose checks hold on a run's input, for the `<learned>`
section, and `seedWorkflows` puts them in the run's own store. The thresholds are the host's.
