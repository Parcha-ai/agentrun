# An agent that learns in its own git repository

An issue-triage agent keeps its definition, rules and skills in a git repository. One run notices something general and
notes it with `learn`, a tool that costs nothing. The host proposes the note on the run's own branch, curation merges it to
`main`, and the next run starts at the new `main` with the lesson in its prompt. That run also saves a workflow with the
DSL's `agentrun` tool; curation admits it as a trial skill, and later runs are offered it. A `git revert` on `main` takes
the lesson back out while the trial stays, and history keeps both. A run that tries to keep a secret proposes nothing.

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
2. Run 1 starts at main a86586d: nothing learned yet
   learn(lesson) -> [noted 1]
     "An issue whose body has a stack trace is a bug report even when its title asks a question: label it bug."
   proposed on runs/run-1 at 5551828; main has not moved

3. Curate asks the judge: narrows a rule? 0.03; general? 0.94
   main e1252eb adds learnings/L-5acfcaa49a21.md

4. Run 2 starts at main e1252eb. Its first model request carries:
     <learned>
     ...
     - L-5acfcaa49a21 lesson: An issue whose body has a stack trace is a bug report even when its title asks a question: label it bug.
     ...
     </learned>
   agentrun(save triage-crash) -> saved triage-crash as 0f207f81a334
   learn(workflow triage-crash) -> [noted 1]
   answer: bug: the body is a crash trace, and L-5acfcaa49a21 says a question with a stack trace is a bug report.

5. Curate admits the workflow as a trial skill
   main 7bdc530 adds .agents/skills/triage-crash/SKILL.md, .agents/skills/triage-crash/trial.json, .pi/agentrun/workflows/triage-crash/...

6. Revert the lesson on main (git revert of the commit that added L-5acfcaa49a21)
   main eab7aa7 reverts e1252eb

7. Run 3 starts at main eab7aa7. Its first model request carries:
     Nothing learned yet (your repo at eab7aa7560b5).
     Workflows to try first for this input: triage-crash (trial). Run one with the agentrun tool; if it escalates, continue yourself.

8. Run 4 tries to learn a value the host holds as a secret
   learn(fact) -> Not noted: it holds a value the host keeps secret. Restate it as a general rule without that.
   proposed nothing; the secret (raw, base64 or hex) is in 0 of 78 git objects (remote and host repository)
```

With flags, run it as `node examples/agent-learn/demo.mjs <flags>`.

| Flag | What it does |
| --- | --- |
| `--dir <path>` | keep the repository, the agent home and the runs there: `git --git-dir <path>/agent.git log --all` |
| `--live` | run 1 to 3 on a real model (below); the judge and run 4 stay scripted |

`node --test examples/agent-learn/demo.test.mjs` runs it offline and checks the story against the repository: run 2's
request carries the lesson, the workflow lands as a trial in the DSL's own layout, run 3's request has no lesson and
offers the trial, main holds no learning after the revert while history keeps it, and the secret is in no git object.

### A real model

`--live` sends runs 1 to 3 to an OpenAI Responses endpoint. Whether the model calls `learn` or saves a workflow, and
what it notes, is then the model's: the transcript shows what happened.

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
| `host.mjs` | the host loop: `prepareRun`, `finishRun`, `curateNow`, and `revertLearning` and `agentHomeFor` |
| `demo.mjs` | the story: a bare repository, four runs, three curations and a revert, with a scripted model |
| `demo.test.mjs` | offline checks of the story |

## The host loop

```js
import { createWorkflowTool } from "@parcha/agentrun-pi/durable";
import { agentLearn, guard } from "@parcha/pi-agent-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { agentHomeFor, curateNow, finishRun, prepareRun } from "./host.mjs";

const repo = await openRepo({ dir: "host-repo", remote: local("agent.git") });
const home = await agentHomeFor({ dir: "home", repo });
const run = await prepareRun({ home, repo, host: "my-host", input });   // fetch main, refresh the home, start, seed <learned> and trials
const learn = agentLearn({ guard, secrets: () => vault });
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
- The model gets `learn` and the `agentrun` tool. It never commits or pushes, and the repository's `.git` is never in its
  workspace. The workflow tool's `projectDir` is the run's workspace, where `finishRun` collects what it saved.
- `finishRun` proposes the run's notes, the DSL records of the workflows it saved, and the trials it used, and refuses
  the whole proposal on any guard hit: a host secret in any encoding, a credential shape, invisible characters, a value
  from the run's input, a path outside the run's own files, or `AGENTS.md` and `agent.json`, which no learning ever writes.
- `curateNow` guards again, asks the judge whether each note is general, whether it narrows a rule, and how it relates to
  the learnings already there, writes `learnings/<id>.md`, admits saved workflows as trials, folds the uses of trials
  into their `trial.json`, and pushes one commit per run to `main`.
- `revertLearning` reverts the curate commit that added a learning, which is everything that run added. Curation never
  brings it back: its run is already named on `main`.

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
- A `git revert` of a curate commit takes out everything that run added, and conflicts once a later curation changed the
  same learning (a `used` mark raised its count). `retireLearning` of `@parcha/pi-agent-learn` takes out one learning, also
  after it was used.
- This demo's runs never run a workflow, so no trial earns uses or promotion here; the workflows package's own tests do.
