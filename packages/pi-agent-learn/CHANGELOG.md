# Changelog

## [Unreleased]

## 0.1.0-beta.22 (2026-10-21)

- New held package `@parcha/pi-agent-learn`: an agent that learns in its own git repository, on top of
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

  Saved workflows are tried and promoted on receipts. `workflowAdmitter` is the curator's `AdmitWorkflow` port for a workflow candidate
  a run saved with the DSL's `agentrun` tool: it validates the run's records through the DSL's public store
  (`@parcha/agentrun-pi/workflows`), holds a workflow with code in it unless the host admits it, saves the revision through the store,
  and returns the files that admit it: the skill (`.agents/skills/<name>/SKILL.md`, whose description is the agent's when-to-use text)
  and `trial.json`, `{ name, status, when, revisions, uses }`, where `when` is optional typed checks on the run's input (a JSON pointer
  and `eq`, `in`, `exists`, `gte` or `lte`; `schemaWhen` derives them from a workflow's input schema). `usesSettler` is the `SettleUses`
  port: it folds a run's uses into `trial.json` by the rules of the archived harness. Promotion rests on independent evidence: a run's uses of one revision are one use, the worst outcome winning, so a trial is promoted after 3 clean runs in a row,
  the live revision is demoted after 2 runs that failed or escalated and the previous active revision comes back with its checks and its
  description, a demoted revision is never tried again, the run that wrote a revision is no evidence for it, and uses count in the
  order they were folded, never a clock. `collectWorkflows` and `inboxWorkflowFiles` hand a run's new revisions to its inbox,
  `collectUses` reads from the run's store (read only, through `recordingLines`; or from the receipts of a pi session with
  `readSessionUses`) which saved workflow each durable workflow task ran and whether it finished `frozen`, `escalated` or `failed`,
  `workflowsToTry` lists the trial and active workflows whose checks hold on a run's input, for the `<learned>` section, and
  `seedWorkflows` puts them in the run's own store. The thresholds are the host's.
  `curate` uses `workflowAdmitter()` and `usesSettler()` when its `admitWorkflow` and `settleUses` options are omitted, so a host cannot
  forget the workflow pieces (`null` turns one off), and `proposeLearning` takes the run's working directory (`workDir`): it collects
  what the run saved and how it used what it had, reading the uses from an open Session with a commit that only scans the workflow
  tasks (`readUses` takes `{ target }` as well as `{ store }`), and proposes them with the run's candidates; an explicit `workflows` or
  `uses` wins.
- `learn` drops an id on a lesson, fact or correction that names no learning the run was given, and keeps the note without
  it, instead of refusing the note; a blank id is no id on every type. A `used` mark with an unknown id is still refused, and
  a `workflow` note's id keeps the DSL's name rule. Models that fill every optional field no longer lose a new note to a
  made-up id.
- Two notes for host authors. The `pi-agent-learn` README says how a judge on a general model, rather than Jev, answers
  curate's questions: ask for `{ answer, confidence }` and derive the yes-probability, since a model asked for a bare
  probability reads it as its confidence. The host integration guide says to give each tool a workflow calls through
  `createWorkflowTool` a `resultSchema`: without one, `describe` reports pi's result envelope and the result reaches the
  next node untyped.
- A workflow a run saved is judged on itself, never on the agent's note. A run that read untrusted content puts none of its own words into a later prompt this way, and a workflow the agent wrote for its job is no longer held because its note sounds like an instruction.
  - `curate` asks no question of a `learn` call of type `workflow` and writes its text nowhere. It reads the run's records through the DSL's store and asks one new question of the document, `workflowCase` (does it name or single out a case, carry a fixed answer, or carry an instruction beyond the job `rules` describe; yes at 0.5 refuses, 0.2 or below passes, between holds), then hands the records to `admitWorkflow` with no description. A host whose scripted judge answers questions by name must answer `workflowCase`. Records the store refuses, and workflows that run code, go straight to the admitter as before.
  - `workflowAdmitter({ describe })` writes the skill's description from the revision's document; the default, `schemaDescription`, names the fields of its input and output by name and type, with no text the agent wrote. A caller that hands over a `description` still gets it; curate never does. `admitInDir`'s `description` may be a function of the document.
  - `proposeLearning({ read })` takes the untrusted text the run read (the pages its tools fetched). A saved workflow 40 or more characters of whose strings (case and whitespace folded) appear in one is withheld from the proposal and named in the result's `withheld`; the rest is proposed. `copiesRead` and `COPIED_TEXT` are the check.
  - `narrowsRules` is not asked of a workflow: a workflow is by design a slice of the job, so measured against rules written for the agent it looks narrower (Jev answered 0.26 to 0.84 on ten workflows an agent wrote for its job), and it cannot change the rules that bind the agent that runs it. `workflowCase`, the copy check, the receipts that promote it and the host's own gates cover it instead.
  - The other questions and every threshold are unchanged; lessons, facts and corrections are judged as before.
- **The host serves a proven workflow itself, before the agent, and a trial is promoted after 2 clean runs by default**
  - `planServing({ repo, sha, workDir, workflows, takes })` picks what to serve for a run: the live revision when it is active; while it is on trial, the revision it superseded, the last one proven (a canary), read from the repository and checked against its digest, so the trial still earns its place through the agent; nothing for a first revision on trial. A superseded revision whose record does not read is passed over for the one before it.
  - `serve({ harness, workflows, context, plan, input, tools, check })` runs the plan as a durable workflow task under `host:<name>:<sha256>:<input hash>` (`hostKey`, `hostRunName`), after the checks the `agentrun` tool makes (a refusal writes no task). A complete run whose output the host's `check` accepts is the answer; one it refuses is escalated with the problems. `takes` and `check` are the host's: nothing about a job is in the package.
  - `readUses`, `collectUses`, `usesSource` and `proposeLearning` take `served`: each served run is a use of its own revision under its name with the host's verdict, though the run's own store need not hold that revision. A canary's uses never count toward the trial.
  - `servingRevision(trial, { unrunnable })` and `readRevision(repo, name, sha256, ref)` are the two pieces `planServing` stands on, for a host that serves on its own terms. `trialFirstText({ name, served, trial })` is what the agent is told when a canary does not finish: the trial is named and asked to run first, the job done by hand only if it escalates too.
  - The `<learned>` section's workflows line, when one of them is on trial, adds that a workflow on trial earns trust only from its own clean runs: run it before doing the job by hand, and change it only after it escalates or fails.
  - A trial is promoted after 2 clean runs in a row by default, not 3 (`PROMOTION_DEFAULTS.promoteAfter`); demotion stays after 2. A host that wants more sets `usesSettler({ thresholds: { promoteAfter } })`, as `examples/agent-learn` does with 3.
- Curation now reports two things it used to lose or stop on.
  - A run's `uses/<run id>.json` is read by the same rules the uses settler folds by. A file the settler could not fold (a name pi cannot load as a skill, or more uses than a run writes) is now refused in the report as `uses: the uses file does not parse`. Before, it passed curation's own looser check, the settler held it under a name that is not a workflow, and the run's uses disappeared from the report.
  - A `trial.json` on main that does not parse now holds that workflow (`its trial.json on main does not parse (format), so the workflow was held`) instead of throwing out of `curate()` and stopping every later run's curation.
- The README reads right outside this repository: its links to `@parcha/pi-git-remote` and `@parcha/pi-durable-agent` are full URLs, so they work on npm; the layout lists `inbox/<run id>/workflows/<name>/` once; it says the host-step blocks are a host's lines (with what `repo`, `harness`, `run` and `vault` stand for), that `createJevRunner` is a separate install that reads its key from the environment, and where `uses/<run id>.json` comes from (the `uses` option, or the run's store with `workDir`), in place of "a later part supplies".
