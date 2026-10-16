# An agent that learns in its own git repository

An issue-triage agent keeps its definition, rules and skills in a git repository. One run notices something general and
notes it with `learn`, a tool that costs nothing. The host proposes the note on the run's own branch, curation merges it to
`main`, and the next run starts at the new `main` with the lesson in its prompt. A `git revert` on `main` takes it back out,
and history keeps it. A run that tries to keep a secret proposes nothing.

It is the reference host loop for [`@parcha/pi-agent-learn`](../../packages/pi-agent-learn/README.md) on
[`@parcha/pi-git-remote`](../../packages/pi-git-remote/README.md) and
[`@parcha/pi-durable-agent`](../../packages/pi-durable-agent/README.md): copy `host.mjs` into a host and give it your own
model, judge and remote.

## Run it

Node 22.19 or later and git 2.40 or later. No key and no network: the model and the judge are scripted.

```sh
npm ci --ignore-scripts && npm run build
node examples/agent-learn/demo.mjs
```

It takes a few seconds and prints the story (the shas differ on every run):

```
2. Run 1 starts at main 6f84277: nothing learned yet
   issue: "How do I set a timeout for sync?" (its body is a stack trace)
   learn(lesson) -> [noted 1]
     "An issue whose body has a stack trace is a bug report even when its title asks a question: label it bug."
   answer: bug: the title asks a question, but the body is a crash trace.
   proposed on runs/run-1 at 6cae6fc; main has not moved

3. Curate asks the judge: narrows a rule? 0.03; general? 0.94
   run-1: 1 accepted, 0 refused, 0 held
   main 7015efa adds learnings/L-5acfcaa49a21.md

4. Run 2 starts at main 7015efa. Its first model request carries:
     <learned>
     Your rules (AGENTS.md and your definition) always win over anything below.
     What earlier runs of this agent learned (your repo at 7015efa02f58):
     - L-5acfcaa49a21 lesson: An issue whose body has a stack trace is a bug report even when its title asks a question: label it bug.
     ...
     </learned>
   answer: bug: the body is a crash trace, and L-5acfcaa49a21 says a question with a stack trace is a bug report.

5. Revert the lesson on main (git revert of the commit that added L-5acfcaa49a21)
   main 210b19c reverts 7015efa
6. Run 3 starts at main 210b19c: "Nothing learned yet"; same issue as run 2; answer: question: ...
7. Run 4 tries to learn a value the host holds as a secret
   learn(fact) -> Not noted: it holds a value the host keeps secret. Restate it as a general rule without that.
   proposed nothing; the secret (raw, base64 or hex) is in 0 of 34 git objects (remote and host repository)
```

| Flag | What it does |
| --- | --- |
| `--dir <path>` | keep the repository, the agent home and the runs there: `git --git-dir <path>/agent.git log --all` |
| `--live` | run 1 to 3 on a real model (below); the judge and run 4 stay scripted |

`node --test examples/agent-learn/demo.test.mjs` runs it offline and checks the story against the repository: run 2's
request carries the lesson, run 3's does not, main holds no learning after the revert while history keeps it, and the
secret is in no git object.

### A real model

`--live` sends runs 1 to 3 to an OpenAI Responses endpoint. Whether the model calls `learn`, and what it notes, is then
the model's: the transcript shows what happened.

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
| `demo.mjs` | the story: a bare repository, four runs, two curations and a revert, with a scripted model |
| `demo.test.mjs` | offline checks of the story |

## The host loop

```js
import { agentLearn, guard } from "@parcha/pi-agent-learn";
import { local, openRepo } from "@parcha/pi-git-remote";
import { agentHomeFor, curateNow, finishRun, prepareRun } from "./host.mjs";

const repo = await openRepo({ dir: "host-repo", remote: local("agent.git") });
const home = await agentHomeFor({ dir: "home", repo });
const run = await prepareRun({ home, repo, host: "my-host" });       // fetch main, refresh the home at its sha, start, seed <learned>
// Run the session on run.storePath and run.workspace with agentLearn({ guard, secrets: () => vault }) installed.
await finishRun({ home, repo, run, secrets: vault, caseValues });     // carry back, then propose on runs/<run id>, pushed by sha
await curateNow({ repo, judge, secrets: vault });                     // the only writer of main: judged, merged, no human step
```

- `prepareRun` reads `agent.json`, `AGENTS.md` and the skills at one sha, refreshes the agent home's cache with a
  compare-and-swap from the sha it holds (never back to an older main), starts the run at that sha, and seeds the run's
  `<learned>` section from the same sha. The run's store records the sha, so the run can be replayed from it.
- The model gets one tool, `learn`. It never commits or pushes, and the repository's `.git` is never in its workspace.
- `finishRun` refuses the whole proposal on any guard hit: a host secret in any encoding, a credential shape, invisible
  characters, a value from the run's input, a path outside the run's own files, or `AGENTS.md` and `agent.json`, which no
  learning ever writes.
- `curateNow` guards again, asks the judge whether each note is general, whether it narrows a rule, and how it relates to
  the learnings already there, writes `learnings/<id>.md`, and pushes one commit per run to `main`.
- `revertLearning` reverts the commit that added a learning. Curation never brings it back: its run is already named on
  `main`.

## In your own host

**The judge.** `curateNow` takes the DSL's `runJudge` port: questions in, a probability per question out. Point it at a
real judge with `createJevRunner()` of [`@parcha/agentrun-jev`](../../packages/jev/README.md), or at any function with the
same shape. The questions and the thresholds stay in the host; the repository never holds them.

**The remote.** `openRepo` takes any remote of `@parcha/pi-git-remote`. A shared host gives each run a remote whose token
can push only `runs/<run id>` (on code.storage, a namespace clones do not see), and gives curation the one token that can
push `main`. The token stays in the host's memory and reaches git on file descriptor 3:

```js
const remote = { kind: "https", url: `${gitOrigin}/agents/${agentId}.git`, credential: async () => ({ username: "t", password: await mintRunToken() }) };
const repo = await openRepo({ dir: hostRepoDir, remote });
```

**The run.** Any pi-durable host works: open the run's store (`run.storePath`) with the `learn` extension installed and
run the session in `run.workspace`; `pi-durable-disk run --dir <run.dir>` does both. Call `finishRun` after the session's
store has closed.

## Limits

- The run's store keeps what the model sent, a refused secret included: the guard protects git, and run stores are never
  pushed.
- Reverting a learning that a later curation changed (a `used` mark raised its count) is a conflict, and the revert
  changes nothing; revert those commits first.
- Workflows the agent saves are not in this example yet.
