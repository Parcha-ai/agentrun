# An agent that learns in its own git repository

An issue-triage agent keeps its definition, rules and skills in a git repository, and its own rules (`AGENTS.md`) say
how it learns: "When a maintainer corrects you, call learn with type correction and the general rule, then answer again."
In run 1 a maintainer corrects its labels with a project rule no model can guess from an issue (a stack trace means `bug`
and `needs-repro`). The agent notes the rule with `learn`, a tool that costs nothing. The host proposes the note on the
run's own branch, curation merges it to `main`, and run 2 starts at the new `main` with the rule in its prompt and
applies it, marking it used. Run 2 also saves a workflow with the DSL's `agentrun` tool; curation counts the use, admits
the workflow as a trial skill, and later runs are offered it. Then the maintainer withdraws the rule: `retireLearning`
marks it retired in one commit, so run 3 labels without it, while the trial stays and history keeps every version. A run
that tries to keep a secret proposes nothing. Then the trial earns its place: three more runs are offered it and run it with
the `agentrun` tool, curation counts what the tool left in each run's store and promotes it to active on the third clean
use, and a second revision that escalates twice in a row is demoted and the first comes back
([A workflow earns its place](#a-workflow-earns-its-place)).

It is the reference host loop for [`@parcha/pi-agent-learn`](../../packages/pi-agent-learn/README.md) on
[`@parcha/pi-git-remote`](../../packages/pi-git-remote/README.md) and
[`@parcha/pi-durable-agent`](../../packages/pi-durable-agent/README.md): copy `host.mjs` into a host and give it your own
model, judge and remote.

## Run it

Node 22.19 or later and git 2.40 or later. No key and no network: the model and the judge are scripted.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:learn
```

It takes about ten seconds and prints the story (the shas differ on every run; steps 9 to 12 are [below](#a-workflow-earns-its-place)):

```
2. Run 1 starts at main 246507b: nothing learned yet
   issue: "How do I set a timeout for sync?" (its body is a stack trace)
   answer: bug: the body is a crash trace.
   maintainer: "Correction from the maintainer: in this project an issue whose body has a stack trace is labeled bug and needs-repro. Remember that for next time."
   learn(correction) -> [noted 1]
     "In this project an issue whose body has a stack trace is labeled bug and needs-repro."
   answer: bug, needs-repro: the body is a crash trace, and this project labels those needs-repro too.
   proposed on runs/run-1 at c3bde9f; main has not moved

3. Curate asks the judge: narrows a rule? 0.03; general? 0.94
   run-1: L-43c99595a04d accepted (general, new)
   main 53f3853 adds learnings/L-43c99595a04d.md

4. Run 2 starts at main 53f3853. Its first model request carries:
     <learned>
     ...
     - L-43c99595a04d correction: In this project an issue whose body has a stack trace is labeled bug and needs-repro.
     ...
     </learned>
   issue: "Can uploads retry on their own?" (its body is a stack trace)
   learn(used L-43c99595a04d) -> [noted 1]
   agentrun(inspect) -> valid; kept as this conversation's draft
   agentrun(save triage-crash) -> saved triage-crash as 2bfc0cd79680
   learn(workflow triage-crash) -> [noted 2]
   answer: bug, needs-repro: the body is a crash trace, and L-43c99595a04d says this project labels those needs-repro too.
   proposed on runs/run-2 at 699c21c: its notes and the workflow's DSL records

5. Curate counts the use and admits the workflow as a trial skill
   run-2: L-43c99595a04d used (uses 1); workflow triage-crash admitted as a trial
   main efd3335 adds .agents/skills/triage-crash/SKILL.md, .agents/skills/triage-crash/trial.json, .pi/agentrun/workflows/triage-crash/2bfc0cd79680....json, .pi/agentrun/workflows/triage-crash/latest; changes learnings/L-43c99595a04d.md

6. The maintainer withdraws the rule: retire L-43c99595a04d
   a git revert of 53f3853, the commit that added it, would conflict: efd3335 changed the entry since (its uses)
   main 5bce08b retires it: learnings/L-43c99595a04d.md stays on main with status retired, and history keeps every version
   curate again: nothing to curate, the rule does not come back; main stays 5bce08b

7. Run 3 starts at main 5bce08b. Its first model request carries:
     Nothing learned yet (your repo at 5bce08befafb).
     Workflows to try first for this input: triage-crash (trial). Run one with the agentrun tool; if it escalates, continue yourself.
   triage-crash 2bfc0cd79680 is in the run's own workflow store for the agentrun tool to load
   same issue as run 2; this scripted run does not try the workflow; answer: bug: the body is a crash trace.

8. Run 4 tries to learn a value the host holds as a secret
   learn(fact) -> Not noted: it holds a value the host keeps secret. Restate it as a general rule without that.
   proposed nothing; the secret (raw, base64 or hex) is in 0 of 86 git objects (remote and host repository)
```

With flags, run it as `node examples/agent-learn/demo.mjs <flags>`.

| Flag | What it does |
| --- | --- |
| `--dir <path>` | keep the repository, the agent home and the runs there: `git --git-dir <path>/agent.git log --all` |
| `--live` | run 1 to 3 on a real model (below), with the same maintainer correction; the judge, run 4 and steps 9 to 12 stay scripted (and step 9 on is skipped, since it needs run 2's scripted workflow) |

`node --test examples/agent-learn/demo.test.mjs` runs it offline and checks the story against the repository: run 1's
first answer lacks the rule and its corrected one has it, run 2's request carries the rule and its answer applies it, the
use is counted and the workflow lands as a trial in the DSL's own layout, main keeps the entry retired with every version
in history, run 3's request has no rule and its answer does not apply it, and the secret is in no git object. It also
checks that the trial is promoted on the third clean use and that a revision is demoted and rolled back after two
escalations, each use read from the records the `agentrun` tool left in the run's own store.

### A real model

`--live` sends runs 1 to 3 to an OpenAI Responses endpoint, run 1 with the same maintainer correction. Whether the model
calls `learn` or saves a workflow, and what it notes, is then the model's: the transcript shows what happened. A model
that answers right on its own has nothing to learn; the correction is the signal, and `AGENTS.md` says what to do with it.

| Variable | Needed | What |
| --- | --- | --- |
| `AGENT_MODEL_BASE_URL` | yes | an OpenAI Responses endpoint, such as `https://api.openai.com/v1` |
| `AGENT_MODEL` | yes | the model id there |
| `AGENT_MODEL_API_KEY` | no | its key, when it needs one |
| `AGENT_THINKING` | no | `minimal`, `low`, `medium` (default), `high` or `xhigh` |

## A workflow earns its place

A saved workflow starts as a trial and keeps its place only on receipts. Curation never asks a model whether the workflow was
good: it counts how each run that used it ended, as the `agentrun` tool recorded it.

- **A use** is what one run did with a revision of the workflow, read by the host from the run's own store after the run
  (`finishRun` passes the run's `workDir` to `proposeLearning`, which reads the `agentrun.workflow` tasks the `agentrun` tool
  left there), never reported by the model. It ends `frozen` when the workflow finished the case by itself, `escalated` when a
  gate fired and the agent took over, or `failed` when it did not finish. A run that only loads, inspects or dry-runs a
  workflow makes no use, and neither does a workflow the run did not save under a name.
- **A run is one use of a revision.** However many cases a run gave the workflow, curation counts it once, and the worst
  outcome wins (`failed` over `escalated` over `frozen`); the other cases are named as `same_run` in the report. So promotion
  and demotion rest on distinct runs, and one run cannot promote a trial alone.
- **Three clean runs promote.** A trial whose last three uses, three distinct runs, all ended `frozen` becomes `active`. The
  run that wrote a revision is no evidence for it.
- **Two failed or escalated runs in a row demote and roll back.** The live revision is marked `demoted`, and the revision it
  replaced, kept as `superseded` with its preconditions and the description of its skill, is active again. With none to
  restore, the name is demoted whole and its skill is removed, so no run is offered it.
- **A demoted revision never returns.** Its record stays on main, so a run that saves the same document again has nothing
  new to propose, and the admitter refuses it if a proposal for it reached curation anyway. Only a changed document, a new
  digest, is tried under the name again.

Steps 9 to 12 of the demo show each rule, with real runs on the scripted model. Runs 5 to 7 each load `triage-crash` by name
and run it; every use below is what `proposeLearning` read from that run's store, and every decision is curation's:

```
9. A workflow earns its place: later runs are offered triage-crash and run it with the agentrun tool
   a use is frozen when the workflow finished the case by itself; three frozen uses in a row promote the trial to active
   run-5 starts at main 61a5dd7, offered triage-crash (trial)
     issue: "Why does export drop my last row?" (its body is a stack trace)
     agentrun(load triage-crash) -> loaded triage-crash 2bfc0cd79680 as this conversation's draft
     agentrun(run) -> complete: labels bug,needs-repro
     answer: bug, needs-repro: triage-crash labeled it, and the body is a crash trace.
     proposed on runs/run-5 at 84c8f91: its workflow uses
     uses/run-5.json: triage-crash 2bfc0cd79680 frozen at 2026-10-16T11:22:10.782Z
     curate: run-5: triage-crash hold: 2bfc0cd79680 has 1 use in its trial; promotion needs its last 3 all frozen
     main ec8d677 changes .agents/skills/triage-crash/trial.json
     trial.json: trial; 2bfc0cd79680 trial; uses run-5 frozen
   run-6 ... (the same: hold, 2 uses)
   run-7 starts at main 15aacf4, offered triage-crash (trial)
     ...
     curate: run-7: triage-crash promote: its last 3 uses all finished frozen
     main 79d62dc changes .agents/skills/triage-crash/trial.json
     trial.json: trial -> active; 2bfc0cd79680 active; uses run-5 frozen, run-6 frozen, run-7 frozen
```

Run 8 then saves a second revision of the workflow, one that hands an issue with no body to a person. The first revision is
active, so the new one is the live trial and the first is kept as superseded. Runs 9 and 10 are offered the trial and
each get an issue with no body, so the tool's run ends `escalated` at the gate both times, and the second use demotes it:

```
11. Two issues in a row reach the new revision with no body: it escalates both times
   run-9 starts at main 96b3637, offered triage-crash (trial)
     issue: "Sync crashes on startup" (it has no body)
     agentrun(load triage-crash) -> loaded triage-crash 5046cece45f8 as this conversation's draft
     agentrun(run) -> escalated at "no body to read": the issue has no body, so there is nothing to read
     uses/run-9.json: triage-crash 5046cece45f8 escalated at 2026-10-16T11:22:15.334Z
     curate: run-9: triage-crash hold: 5046cece45f8 has 1 use in its trial; promotion needs its last 3 all frozen
   run-10 starts at main af92bdb, offered triage-crash (trial)
     ...
     uses/run-10.json: triage-crash 5046cece45f8 escalated at 2026-10-16T11:22:16.560Z
     curate: run-10: triage-crash demote, back to 2bfc0cd79680: its last 2 uses ended escalated, escalated
     main e2f1da0 changes .agents/skills/triage-crash/trial.json, .pi/agentrun/workflows/triage-crash/latest
     trial.json: trial -> active; 2bfc0cd79680 active, 5046cece45f8 demoted; uses run-5 frozen, run-6 frozen, run-7 frozen, run-9 escalated, run-10 escalated
```

Run 11 is offered the first revision again, as active. It saves the demoted document once more, and proposes nothing.

## The files

| File | What |
| --- | --- |
| `agent/` | the agent the repository starts with: `agent.json`, `AGENTS.md` and `skills/triage/SKILL.md` (committed as `.agents/skills/triage/SKILL.md`) |
| `host.mjs` | the host loop: `prepareRun`, `learnExtension`, `finishRun`, `curateNow`, and `agentHomeFor` |
| `demo.mjs` | the story: a bare repository, four runs, three curations and a retire, then seven runs that try the workflow, with a scripted model |
| `demo.test.mjs` | offline checks of the story |

## The host loop

```js
import { createWorkflowTool } from "@parcha/agentrun-pi/durable";
import { local, openRepo } from "@parcha/pi-git-remote";
import { agentHomeFor, curateNow, finishRun, learnExtension, prepareRun } from "./host.mjs";

const repo = await openRepo({ dir: "host-repo", remote: local("agent.git") });
const home = await agentHomeFor({ dir: "home", repo });
const run = await prepareRun({ home, repo, host: "my-host", input });   // fetch main, refresh the home, start, seed <learned> and trials
const learn = learnExtension({ secrets: vault, caseValues });            // agentLearn, its guard seeing this run's input values
const workflowTool = createWorkflowTool({ projectDir: run.workspace, tools, task });
// Install both in the run's registry, and root the conversation on them: { extensions: [learn, workflowTool.extension] }.
await finishRun({ home, repo, run, secrets: vault, caseValues });       // carry back, then propose notes and saved workflows
await curateNow({ repo, judge, secrets: vault });                       // the only writer of main: judged, merged, no human step
```

List every extension the agent's conversation needs in the root agent's extensions, including agentLearn and the workflow tool; installing in the registry alone is not enough.

- `prepareRun` reads `agent.json`, `AGENTS.md` and the skills at one sha (a learned workflow skill only while its trial
  is live), refreshes the agent home's cache with a compare-and-swap from the sha it holds (never back to an older main),
  starts the run at that sha, seeds the run's `<learned>` section from the same sha, and puts the trials that fit `input`
  into the run's own workflow store.
- `learnExtension` is `agentLearn` with the guard given the host's secrets and the run's input values at every call, so a
  note that would refuse the whole proposal at the end (one that repeats the issue number, say) is refused while
  the model can still restate it.
- The model gets `learn` and the `agentrun` tool. It never commits or pushes, and the repository's `.git` is never in its
  workspace. The workflow tool's `projectDir` is the run's workspace, where `finishRun` collects what it saved.
- `finishRun` proposes the run's notes, the DSL records of the workflows it saved, and the trials it used, and refuses
  the whole proposal on any guard hit: a host secret in any encoding, a credential shape, invisible characters, a value
  from the run's input, a path outside the run's own files, or `AGENTS.md` and `agent.json`, which no learning ever writes.
- `curateNow` guards again, asks the judge whether each note is general, whether it narrows a rule, and how it relates to
  the learnings already there, writes `learnings/<id>.md`, admits saved workflows as trials, folds the uses of trials
  into their `trial.json`, and pushes one commit per run to `main`.
- `retireLearning({ repo, id, reason })` of `@parcha/pi-agent-learn` takes a learning out: one commit on main that marks
  it retired and keeps its file. A retired learning is never in `<learned>` again, and curation never brings it back.

## In your own host

**The judge.** `curateNow` takes the DSL's `runJudge` port: questions in, a probability per question out. Point it at a
real judge with `createJevRunner()` of [`@parcha/agentrun-jev`](../../packages/jev/README.md), or at any function with the
same shape. The questions and thresholds live in the package and the host, never in the agent's repository.

**The remote.** `openRepo` takes any remote of `@parcha/pi-git-remote`. A shared host gives each run a remote whose token
can push only `runs/<run id>` (on code.storage, a namespace clones do not see), and gives curation the one token that can
push `main`. The token stays in the host's memory and reaches git on file descriptor 3:

```js
const remote = { kind: "https", url: `${gitOrigin}/agents/${agentId}.git`, credential: async () => ({ username: "t", password: await mintRunToken() }) };
const repo = await openRepo({ dir: hostRepoDir, remote });
```

**The run.** Any pi-durable host works: open the run's store (`run.storePath`) with both extensions installed and listed
on the root agent, and run the session in `run.workspace`; `pi-durable-disk run --dir <run.dir> --app <your app>` does
both when the app does. Call `finishRun` after the session's store has closed.

## Limits

- The run's store keeps what the model sent, a refused secret included: the guard protects git, and run stores are never
  pushed.
- `git revert` of the curate commit that added a learning works only before any run used it: a `used` mark changes the
  entry, and the revert then conflicts. It also takes out everything else that run added. `retireLearning` is the general
  way out.
- Steps 9 to 12 run the workflow with a scripted model, and its one tool, `issues.label`, is a stub that answers with the
  labels it was given. A real host gives the workflow's tools to `createWorkflowTool` and runs the same loop.
- A run that runs the workflow on several cases is one use of that revision, with its worst outcome, so a host that wants
  several uses gives each case its own run.
