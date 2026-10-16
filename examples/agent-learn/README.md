# An agent that learns in its own git repository

An issue-triage agent keeps its definition, rules and skills in a git repository, and its own rules (`AGENTS.md`) say
how it learns: "When a maintainer corrects you, call learn with type correction and the general rule, then answer again."
In run 1 a maintainer corrects its labels with a project rule no model can guess from an issue (a stack trace means `bug`
and `needs-repro`). The agent notes the rule with `learn`, a tool that costs nothing. The host proposes the note on the
run's own branch, curation merges it to `main`, and run 2 starts at the new `main` with the rule in its prompt and
applies it, marking it used. Run 2 also saves a workflow with the DSL's `agentrun` tool; curation counts the use, admits
the workflow as a trial skill, and later runs are offered it. Then the maintainer withdraws the rule: `retireLearning`
marks it retired in one commit, so run 3 labels without it, while the trial stays and history keeps every version. A run
that tries to keep a secret proposes nothing.

It is the reference host loop for [`@parcha/pi-agent-learn`](../../packages/pi-agent-learn/README.md) on
[`@parcha/pi-git-remote`](../../packages/pi-git-remote/README.md) and
[`@parcha/pi-durable-agent`](../../packages/pi-durable-agent/README.md): copy `host.mjs` into a host and give it your own
model, judge and remote.

## Run it

Node 22.19 or later and git 2.40 or later. No key and no network: the model and the judge are scripted.

```sh
npm ci --ignore-scripts && npm run build && npm run demo:learn
```

It takes a few seconds and prints the story (the shas differ on every run):

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
| `--live` | run 1 to 3 on a real model (below), with the same maintainer correction; the judge and run 4 stay scripted |

`node --test examples/agent-learn/demo.test.mjs` runs it offline and checks the story against the repository: run 1's
first answer lacks the rule and its corrected one has it, run 2's request carries the rule and its answer applies it, the
use is counted and the workflow lands as a trial in the DSL's own layout, main keeps the entry retired with every version
in history, run 3's request has no rule and its answer does not apply it, and the secret is in no git object.

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

## The files

| File | What |
| --- | --- |
| `agent/` | the agent the repository starts with: `agent.json`, `AGENTS.md` and `skills/triage/SKILL.md` (committed as `.agents/skills/triage/SKILL.md`) |
| `host.mjs` | the host loop: `prepareRun`, `learnExtension`, `finishRun`, `curateNow`, and `agentHomeFor` |
| `demo.mjs` | the story: a bare repository, four runs, three curations and a retire, with a scripted model |
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
  note that would refuse the whole proposal at the end (a made-up id that repeats the issue number, say) is refused while
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
- This demo's runs never run a workflow, so no trial earns uses or promotion here; the workflows package's own tests do.
