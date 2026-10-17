---
packages: @parcha/pi-agent-learn
kind: feature
---
New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
`@parcha/pi-git-remote`. `agentLearn()` is a pi-durable extension with one tool, `learn({ type, text, evidence?, id? })`
(a lesson, a fact, a correction, a `used` mark on a learning that helped, or a `workflow` note on when to use a workflow
the run saved), which stores one candidate per call id in the run's store, is replay safe and makes no model call; an id
must name a learning the run was given, and with the host's guard, secrets and case values a refused note is refused at
the call, where the model can restate it. The extension also adds the `<learned>`
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
the joiners of scripts that need them allowed; any value from the run's input in what the agent wrote (case data; call ids, run ids, seeds and digests are generated and never
checked for it); each role's own paths (a run
writes its inbox, uses and workflow-record files, the curator writes learnings, skill folders and the workflow store; `AGENTS.md`, `agent.json`
and any `.git` segment never, in any spelling); and size and count caps. `proposeLearning` is the host step at a run's
terminal: it collects the run's candidates, renders `inbox/<run id>.md`, adds the DSL's saved workflow records the host
collected (`inbox/<run id>/workflows/<name>/`), guards the whole proposal, and makes one commit on
`runs/<run id>` through `@parcha/pi-git-remote`, pushed by sha. A guard hit refuses all of it and commits nothing; a second
call, including one from a restarted host with an empty local repository, commits nothing. `renderInbox` and `parseInbox`
are the inbox's format: the run, the commit it was seeded from (`seed`, from its `learn.seed` record) and, on each candidate,
an `untrusted` mark that `proposeLearning({ untrusted: true })` sets when the run read untrusted content.
