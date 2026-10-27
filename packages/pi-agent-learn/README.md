# @parcha/pi-agent-learn

An agent that learns in its own git repository. While it works, the agent notes what would help a later run with one
tool, `learn`, which costs nothing. The host proposes those notes on the run's branch, a curator merges the good ones to
`main`, and every later run reads them in a short `<learned>` section of its prompt, taken from the commit it was seeded
from. A bad lesson is undone with `git revert`, and history keeps it.

It builds on [`@parcha/pi-git-remote`](https://github.com/Parcha-ai/agentrun/tree/main/packages/pi-git-remote), which
owns git, and on pi-durable, which owns the run. The host owns git: no model tool commits or pushes, and the
repository's `.git` is never in the agent's working directory.

This release has the contract the model sees, the host step that seeds a run, the guard every write goes through, the
host step that proposes a run's notes, the curator that merges them to `main`, and saved workflows that are tried and
promoted on receipts.

> **What this first version is**
>
> - A pi-durable SDK extension that a host program installs in its `Harness`, not a `pi install` package.
> - Installing it also installs `@parcha/pi-git-remote`, `@parcha/agentrun-learn`, `@parcha/agentrun-dsl` and
>   `@parcha/agentrun-pi`, and, through `@parcha/agentrun-pi`, `@parcha/agentrun-jev`.
> - The notes loop is the core: `learn`, seeding, proposing and curating. Workflow trials, serving and promotion are
>   experimental.
> - Curating needs a judge: Jev (`createJevRunner` from `@parcha/agentrun-jev`) with a TypeSafe key in
>   `TYPESAFE_API_KEY`, or your own function on any model ([A judge on any model](#a-judge-on-any-model)).
> - The whole loop, host included, is
>   [`examples/agent-learn`](https://github.com/Parcha-ai/agentrun/tree/main/examples/agent-learn): run
>   `npm run demo:learn` in a clone of this repository, with no key and no network.

## Quickstart (no key, no network)

Node 22.19 or later and git 2.40 or later. In an empty directory:

```sh
npm install @parcha/pi-agent-learn@beta @parcha/pi-git-remote@beta @earendil-works/pi-durable@1.3.0 @earendil-works/pi-ai@1.3.0 @earendil-works/chord@1.3.0
```

pi 1.4 is not supported yet; a later release widens the range.

Save this as `quickstart.mjs` and run `node quickstart.mjs`. The model is pi-ai's scripted faux provider.

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { local, openRepo } from "@parcha/pi-git-remote";
import { agentLearn, collectCandidates, renderLearning, seedLearning } from "@parcha/pi-agent-learn";

// The agent's repository: its rules, and one learning as a curator would have merged it.
const root = mkdtempSync(path.join(tmpdir(), "acme-"));
const remoteDir = path.join(root, "acme.git");
execFileSync("git", ["init", "-q", "--bare", "--template=", "-b", "main", remoteDir]);
const repo = await openRepo({ dir: path.join(root, "host"), remote: local(remoteDir) });
const lesson = {
  id: "L-3f2a9c1d0e7b", type: "lesson", scope: "all", status: "active", uses: 3, supersedes: [],
  provenance: { runs: ["run-0"], sha: "0".repeat(40), untrusted: false },
  text: "Company registries match the legal name without Inc or LLC; search both forms.",
};
const files = { "AGENTS.md": "# Rules\n\nCite every claim.\n", [`learnings/${lesson.id}.md`]: renderLearning(lesson) };
const main = await repo.commitTo("main", { files, message: "seed" });
await repo.push(main.sha, "main");

// One run: a pi-durable Harness with the learn extension and a model that notes a fact, then answers.
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses([
  (context) => {
    const system = context.messages.find((m) => m.role === "system");
    console.log(Object.values(system.sections ?? {}).find((s) => s.startsWith("<learned>")));
    return fauxAssistantMessage([fauxToolCall("learn", { type: "fact", text: "The state registry rate-limits at 1 request a second." }, { id: "call-1" })], { stopReason: "toolUse" });
  },
  (context) => fauxAssistantMessage([fauxText(`learn said ${context.messages.at(-1).content[0].text}`)], { stopReason: "stop" }),
]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(agentLearn());
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);

const seeded = await seedLearning({ repo, target: harness, into: path.join(root, "work") });
console.log("seeded from", seeded.sha === main.sha ? "main" : seeded.sha, "copied", seeded.files.join(", "));
const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "Research the company." } });
await (await conversation.submit({ type: "input", content: "Check Acme." }, ctx)).wait(ctx);
console.log("candidates:", JSON.stringify(await collectCandidates(harness)));
await harness.close(ctx);
```

```
seeded from main copied .agent/learnings/L-3f2a9c1d0e7b.md
<learned>
Your rules (AGENTS.md and your definition) always win over anything below.
What earlier runs of this agent learned (your repo at <sha>):
- L-3f2a9c1d0e7b lesson: Company registries match the legal name without Inc or LLC; search both forms. (used 3)
The full entries are in .agent/learnings/.
When you notice something general that would help next time, call learn. When a line above helped, call learn with type "used" and its id.
Never put names, ids or data from this case into a learning.
</learned>
candidates: [{"callId":"call-1","type":"fact","text":"The state registry rate-limits at 1 request a second.","evidence":[]}]
```

`<sha>` is the first 12 hex digits of the commit the quickstart made.

## The repository

```
repo/
  agent.json                       rules tier: the agent definition; no learning writes it
  AGENTS.md                        rules tier: the standing rules; no learning writes it
  .agents/skills/<name>/SKILL.md   skills
  .agents/skills/<name>/trial.json a workflow's standing and uses; the host writes it, never a run
  learnings/INDEX.md               one line per active learning
  learnings/<id>.md                one learning per file
  workflows/<name>/workflow.json   a workflow: a run's draft on its branch, the live revision on main
  workflows/<name>/README.md       what the workflow is; on main it points at the skill
  workflows/<name>/<sha256>.json   the DSL's saved records and `latest`, on main only; the host writes them
  memos/<run id>.md                each run's memo: proposed on its branch, merged with the review's verdict
  uses/<run id>.json               a run's workflow uses, on runs/<run id> only
```

This is the layout `@parcha/agentrun-learn`'s SPEC.md sets for every harness, and its checker validates a run's branch
before curation. An older repository kept its workflow records under `.pi/agentrun/workflows/<name>/`: every read tries
`workflows/<name>/` first and that folder second, so it keeps working with no migration, and the next curation that
changes a workflow writes it at the new path.

`RULES_LOCKED` is the frozen list `["agent.json", "AGENTS.md"]`. `isRulesLocked(path)` is true for either name in any
segment of a path and in any spelling a file system or git could treat as the same file (case, Unicode compatibility
forms, ignorable characters, trailing dots or spaces, an NTFS stream suffix, an 8.3 short name). `assertNotRulesLocked`
throws for such a path; every writer calls it. `LAYOUT`, `tierOf`, `runBranch`, `memoPath`, `usesPath`, `learningPath`,
`repoWorkflowDir`, `WORKFLOW_NAME` and `CAPS` fix the rest of the layout and its size caps.

A learning is one file: frontmatter, then the general rule.

```
---
id: L-3f2a9c1d0e7b
type: lesson
scope: all
status: active
provenance:
  runs: ["run-0"]
  sha: <the commit run-0 was seeded from>
  untrusted: false
uses: 3
supersedes: []
---
Company registries match the legal name without Inc or LLC; search both forms.
```

`status` is `active`, `superseded`, `archived` (the least used, past the section's cap) or `retired` (taken out on
purpose). A superseded learning also has `supersededBy: <id>` after `supersedes`, naming the one that replaced it.
`provenance.sha` is the commit the first run was seeded from, which its branch starts at and its memo names as `base`;
for a run that was not seeded, it is the main commit the run's branch starts from, and `  shaFrom: branch-base` says so.
`renderLearning` writes exactly this and `parseLearning` reads nothing looser: an unknown, missing or repeated key, or a
value out of shape, is a `LearnError` with code `format`. `learningId(runId, text)` is `L-` and 12 hex digits of SHA-256
over the run id and the text, so curating the same candidate twice cannot make two learnings.

## What the model sees

| Tool | Arguments | Returns |
| --- | --- | --- |
| `learn` | `{ type: "lesson" \| "fact" \| "correction" \| "used" \| "workflow", text, evidence?: string[], id?: string }` | `[noted <n>]` |

`learn` writes one candidate into the run's own pi-durable store (the session document `learn.candidates`), keyed by the
call id, inside the tool's commit. It is replay-safe: a call rerun after a crash finds its candidate and stores nothing
new. It makes no model call. A `used` mark names the learning that helped by its id, which must be a learning this run
was given (listed in its section, or over the cap), or the mark is refused at the call. A `workflow` note names a workflow
the run saved (its name, by the DSL's rule: 1 to 64 lowercase letters, digits, dashes or underscores) and says in its
text when to use it; curation judges the workflow itself and writes the note's text nowhere (below). A lesson, fact or correction keeps an id only when it names a learning this run was given; any other
id, a blank one included, is dropped and the note kept without it. Text is at most 1,000 bytes, and
evidence at most 8 items and 1,000 bytes in all; a run makes at most 8 notes of every type but `used`, and 32 `used` marks. Evidence stays with the run and is
never part of a learning. `agentLearn({ guard, secrets, caseValues })` checks every call with the host's guard first,
with the host's secrets and this run's input values; a refused call stores nothing and its result names the reason,
never the value, so the model can restate it as a general rule at once. The result carries its text under both `content` and
`output`, so pi-durable 1.1, 1.2 and 1.3 all show it to the model.

The `<learned>` section says that the rules win, lists the active learnings at the seeded commit (most used first, the
first line of each), names the workflows to try for this input (when one is on trial, it says to run it before doing the
job by hand and to change it only after it escalates or fails: only its own clean runs earn it trust), and tells the
agent when to call `learn`. It renders
from the run's `learn.seed` record, so it is the same on every request of a run and the same for every run seeded from
one commit. It holds at most 4,096 bytes: learnings that do not fit are not loaded, the section says how many, and their
ids are in the record. A learning whose first line holds the section's tag is never loaded. Without `learn` among the
agent's tools, the lines that ask it to call `learn` are left out.

## Host steps

The blocks from here on are a host's lines, not programs to run: `repo` is an `openRepo` result and `harness` a
pi-durable Harness, as in the quickstart; `run` is the host's record of the run, and `vault.values()` its secret values.

```ts
const seeded = await seedLearning({ repo, ref: "main", target: harness, into: run.workspace, workflows });
const extension = agentLearn({ guard, secrets: () => vault.values(), caseValues: () => run.inputValues });
const candidates = await collectCandidates(harness);
```

`seedLearning` fetches, resolves `ref`, reads `learnings/*.md` at that commit, derives the index under the cap, records
`{ sha, index, omitted, workflows, copied }` in the run's store as `learn.seed`, and copies the active learnings to
`<into>/.agent/learnings/<id>.md` for the agent to read. Each copy is written into a staging directory the call creates
under `.agent/` and renamed over its name, so an interrupted copy never leaves a partial file there, and seeding again
restores the stored bytes over an edited copy or a link. A call removes only its own staging directory, so two seeds
into one directory at once both finish whole. Edits there are never committed. A file
that is misnamed, does not parse, is a symlink or is over 4 KB is skipped and named in `skipped`. A run is seeded once:
when its store already holds a seed, that commit is used again and the record is kept, so a restarted host never moves a
run to a newer commit. `readSeed` returns the record; `collectCandidates` returns the run's candidates in order.
`workflows` is a list of `{ name, status: "trial" | "active" }`, at most 8: what `workflowsToTry` returns (below).

With [`@parcha/pi-durable-agent`](https://github.com/Parcha-ai/agentrun/tree/main/packages/pi-durable-agent), the run
starts at the same commit: the host reads `agent.json` and
`.agents/skills/` at the sha with `repo.read` and `repo.list`, keeps the agent home on it (`createAgentHome(dir, {
definition, skills, sha })`, then `refreshAgentHome(home, { sha, from, definition, skills })` when main moves), starts the
run with `startRun(home, { host, sha })`, and seeds it with `seedLearning({ repo, ref: started.sha, target, into:
started.workspace })`. The runs index, `learn.seed` and the section then all name that sha.

Every failure is a `LearnError` with a `code`: `invalid`, `format`, `missing`, `rules_locked`, `too_large`, or, from
`curate`, `contended` and `judge`.

## The guard

```ts
const refusals = guard({ role: "run", runId, files, candidates, secrets: vault.values(), caseValues });
```

`guard` returns every reason a write may not happen, or an empty list. It makes no model call, refuses and never
redacts, and no refusal repeats the value it matched: a file name that holds a secret is left out of the refusal that
names it. `createGuard(caps)` makes one with other byte and count caps than `CAPS`. Every writer runs it before anything
reaches git: `agentLearn({ guard })` on each `learn` call (candidates only, no run id needed), `proposeLearning` on the
whole proposal, and the curator on what it writes.

| Reason | What it refuses |
| --- | --- |
| `secret_value` | A value in `secrets` as written; with its whitespace removed (a value split over lines); as base64 or base64url at any of the three alignments, wrapped or not; as hex in either case; percent or form encoded. Every string inside a `.json` file is searched past its escapes. A secret of fewer than 8 characters cannot be matched without false hits, so the guard answers `invalid` to everything until the host drops it. |
| `secret_shape` | AWS access key ids (`AKIA`, `ASIA`), Google API keys, private-key blocks (public keys and certificates are fine), GitHub tokens, `sk-` keys, Slack tokens, JWTs, and a URL with a password (`user:pass@`; `user@` alone is fine). |
| `invisible_unicode` | Zero-width, bidirectional, tag, variation-selector, private-use and control characters, in a path or a text. U+FE0F after an emoji, a joiner inside an emoji sequence, and a joiner or non-joiner between letters of a script that needs them (Persian and Urdu, the Indic scripts, Khmer, Myanmar, Sinhala) are text. |
| `case_data` | Any value of 4 or more characters from `caseValues`, matched without case, over Unicode compatibility forms and with whitespace ignored (a value split by a line break is still found), in what the agent wrote: candidate texts, evidence and ids, the text of any other file, and the workflow or skill name in a path. Generated text is not checked, because a short value turns up in it by chance: a call id (never scanned, only checked to be printable ASCII), the run id, seed and digests (a hex run of 32 characters or more is skipped, unless a case value is itself such a hash), the frame of a learning file that is exactly what `renderLearning` writes, and the paths and ids the memo and the index name. A learning states the rule, never the case. |
| `rules_locked` | `AGENTS.md` and `agent.json` for every role, in any spelling (`isRulesLocked`). |
| `path_not_allowed` | A path outside the role's own, any `.git` segment in any spelling, and a path that is not a plain relative one (`..`, `.`, `//`, a backslash, an absolute path, a control character). |
| `too_large`, `too_many` | Over a cap in `CAPS`: bytes per text, per evidence list, per file, per memo, for the index; files per write; new learnings and `used` marks per run. A refused write is never truncated. |
| `invalid` | A run id, role, type, id or secret that is not well formed. |

A run writes its memo, `memos/<run id>.md`, its notes, `learnings/L-<12 hex>.md`, the index, `learnings/INDEX.md`, a
draft per workflow, `workflows/<name>/workflow.json` and `README.md` (`<name>` is a workflow name, `WORKFLOW_NAME`: 1 to 64
lowercase letters, digits, dashes or underscores, starting with a letter or digit), and `uses/<run id>.json`, and nothing
else. The curator writes `learnings/L-<12 hex>.md` (it names every entry by its generated id) and the index, a run's memo,
`.agents/skills/<name>/SKILL.md` and `trial.json` (no other file or folder in a skill folder), and a workflow's folder:
the DSL's records, `workflows/<name>/<sha256>.json` and `latest`, with `workflow.json` and `README.md`. The records,
`latest` and `trial.json` are the host's, so a run that proposes one is refused.

## Proposing a run's notes

```ts
const result = await proposeLearning({ repo, runId, target: harness, secrets: vault.values(), caseValues, workflows });
```

`proposeLearning` is the host step at a run's terminal. It collects the run's candidates and writes the run's branch on
the shared layout, from the commit the run was seeded from (main, for a run that was not seeded):

- the memo, `memos/<run id>.md`: the host's facts in its front matter (`run`, `base` = that commit, `harness: pi`,
  `outcome`, `untrusted`, and `cost_usd` when the host passes `costUsd`), then four sections: `## What happened` and
  `## What could be better` in the agent's words when the host passes its `reflection` (else the host's own lines), and
  `## What I learned` and `## Proposed changes`, which name what the run proposed;
- one note per `lesson`, `fact` or `correction`, in the learning format above, its `supersedes` naming the learning a
  candidate's `id` names;
- one more use on each active learning a `used` mark names (a second mark of the same one, or one naming no active
  learning, changes nothing);
- `learnings/INDEX.md`, when it fits its cap;
- a draft per workflow: `workflows/<name>/workflow.json`, the document the run's store's `latest` names (the `workflows`
  option, per name `{ files: { "<sha256>.json": text, latest: text } }`, or, with `workDir`, what the run saved; see
  [Workflows](#workflows)), and `README.md`, the agent's `workflow` note;
- `uses/<run id>.json` from the run's workflow uses (the `uses` option, or what the run's store holds with `workDir`).

It guards the whole proposal as the `run` role and makes one commit on `runs/<run id>` through `@parcha/pi-git-remote`
with a `Run-Id` trailer, pushed by sha. `@parcha/agentrun-learn`'s checker accepts the branch. The result is one of:

- `{ status: "proposed", sha }`: the commit was made and pushed.
- `{ status: "already", sha }`: the branch already held a commit for this run, from this host or a restarted one with an
  empty local repository; none was made, and the push is repeated so a crash between commit and push heals.
- `{ status: "empty" }`: the run noted nothing.
- `{ status: "refused", refusals }`: any guard hit refuses all of it, and nothing is committed or pushed, so no ref or
  object holds the refused value.

`read` is the untrusted text the run read (the pages its tools fetched, say). A saved workflow any `COPIED_TEXT` (40)
characters of whose strings, case and whitespace folded, appear in one is withheld: its records stay out of the proposal,
the rest is proposed as usual, and a `proposed`, `already` or `empty` result names it in `withheld: [{ name, reason }]`,
with a reason that names nothing the run read. `copiesRead(workflow, read)` is that check.

`reflection` is the agent's reflection, `{ whatHappened, couldBeBetter }`. After the run's answer, a host sends
`REFLECT_PROMPT` as one more message in the same conversation: the agent calls `learn` for what it learned and replies
with the two sections, which `parseReflection(reply)` reads (undefined when either is missing or empty). A section over
`REFLECTION_CHARS` (2000) characters, holding a heading or a `---` line, or a control or invisible character
(`reflectionProblem`), or a reflection in which the guard finds a secret or this case's data, is not written: the
host's lines stand, the notes are proposed as usual, and the result names it in `withheld` as `reflection`.

A push the remote refuses throws a `GitRemoteError`. `proposeFiles` is the same guard-commit-push for files the caller
has already rendered. `runBranchFiles` is the branch's writer and `readRunBranch` its reader: curation reads the run's
candidates back from its notes, its changed uses and its drafts. `proposeLearning({ untrusted: true })` marks the memo and
every note untrusted: the host sets it when the run read untrusted content. A seed that is not a commit of the agent
repository refuses the proposal.

## Curating

```ts
import { createJevRunner } from "@parcha/agentrun-jev";
const report = await curate({
  repo, judge: createJevRunner(), secrets: vault.values(),
  // The injection screen: the host's page judge. Without one, every run is refused: nothing merges unscreened.
  screen: async ({ text }) => (await decisions.classifyPage({ url: "", status: 200, contentType: "text/markdown", text })).injection,
  // The host's tool list, for the checker: a draft that names a tool outside it is refused.
  tools: registeredToolNames,
});
```

`curate` is the host step that writes `main`, and the only one. It takes each branch `runs/<run id>` whose run no
`Curated-Run` trailer in main's history names, in name order. It checks the branch (every commit since main carries
this run's `Run-Id`, and it starts from main's history), reads back everything the run changed, and refuses the whole run,
with nothing of it reaching the judge, when:

- `@parcha/agentrun-learn`'s checker refuses the branch (`checkRun`, with the host's `tools` and secrets): the layout, the
  formats, the caps, the locked and host-owned paths, secret-shaped text, and drafts on the DSL with only the host's tools
  and no code, shell or executor node;
- the guard, as the `run` role with the host's secrets of now, refuses it;
- there is no injection screen: `screen` is missing, or lacks its `classify` judge or its `threshold`.

Both halves of the screen are the host's; this package holds no threshold. A Pi host passes pi-browser's page judge and
its `INJECTION_THRESHOLD` (`import { INJECTION_THRESHOLD } from "@parcha/pi-browser"`): `screen: { classify: async ({ text }) => (await classifyPage({ url: "", status: 200,
contentType: "text/markdown", text })).injection, threshold: INJECTION_THRESHOLD }`. The screen scores every new or
changed note, skill and draft, and the memo, whose refusal refuses no candidate: the memo then lands as the host renders
it (`hostRenderedMemo`: its checked front matter, a line saying why, host lines in the other sections and the paths it
named that the run's branch changed, with no text of the run's and no Review it wrote); a score at or over `threshold` refuses that item, and so does one the screen could not judge: it threw, took longer
than `screenTimeoutMs` (30 s), or answered out of shape. Then curate judges each candidate and writes the result as a
merge commit on `main`: its second parent is the run as it lands (a commit on the run's base holding exactly what curation
took, `Landed-Run: <run id>`), so the run's own branch is never merged and nothing curation refused becomes reachable from
main, and `git revert -m 1` takes the run back out. It carries `Curated-Run: <run id>` and one `Learning-Id` per learning
it touched, and is pushed without force. Its message is the verdict and every reason; the run's memo lands with them as
its `## Review` section, and `learnings/INDEX.md` is rewritten from the active learnings. Holds and refusals are in that
message, so a run that only held still gets its commit and is curated once.

A host that asks a person before a run merges uses three more pieces. `curate({ only: [runId] })` curates just the runs
it names and leaves every other run's branch as it is, unjudged. `curate({ hold: true })` plans each run and commits
nothing: the report's `planned` holds each `{ run, plan, report }`, the plan in plain JSON (`HeldPlan`: the run, main as
it was, the base, the files, the message, the trailers and the memo before its Review). `landHeld({ repo, plan,
decision })` lands it once the person decides: `"approve"` lands it as curate would have, with the run as it lands as
the merge's second parent; `{ refuse: reason }` lands the memo alone, its Review `curate: run <id>: refused by a person:
<reason>` (one line, 1 to 200 characters), so the run counts as curated and is never judged again. A run already
curated answers `already`, and a main that moved since the plan answers `stale` with nothing landed: plan it again.
`landHeld` checks the plan's shape and guards its files as the curator before it writes anything.

The judge is the DSL's System One port, `WorkflowDeps["runJudge"]` from `@parcha/agentrun-dsl`: `createJevRunner` from
`@parcha/agentrun-jev` is one (it comes with this package through `@parcha/agentrun-pi`; add it to your own dependencies
to import it, and it reads its key, `TYPESAFE_API_KEY`, from the environment as its README says), and a test passes a
scripted function. Each question is asked on its own, as a yes-or-no
probability, over the candidate's own text, never a paraphrase (`QUESTIONS` holds the wording):

| Question | Asked of | Yes at or above, no at or below | A yes |
| --- | --- | --- | --- |
| `general` | every new lesson, fact and correction | 0.8, 0.2 | passes; a no refuses it as about this case |
| `narrowsRules` | the same, with `rules` (AGENTS.md at main, or the `rules` option) | 0.5, 0.1 | refuses it |
| `fromContent` | the same, when the candidate is marked `untrusted` | 0.5, 0.1 | refuses it |
| `duplicate` | it and each active learning of its type, and the one a correction names | 0.8, 0.2 | the existing one counts a use and the run joins its provenance |
| `supersedes` | the same pairs | 0.8, 0.2 | it is written and the existing one becomes `superseded`, naming it in `supersededBy` |
| `contradicts` | the same pairs | 0.5, 0.2 | it is held |
| `workflowCase` | each saved workflow a run proposes, its document as the DSL's store reads it, with `rules` | 0.5, 0.2 | refuses it |

### A judge on any model

A judge on a general model rather than Jev does best asking it for `{ answer: "yes" | "no", confidence }`, with
`confidence` from 0.5 to 1, and deriving the yes-probability itself: `{ type: "noul", noul }`, where `noul` is the
confidence for a yes and 1 minus it for a no. Asked for a bare probability, a model reads it as how sure it is of its
answer, so a sure no comes back as a likely yes. With pi-ai, where `models` is your `createModels()` registry with a
provider set and `model` one of its chat models:

```js
const judge = async ({ state, questions }) => {
  const answers = {};
  for (const [name, { instructions }] of Object.entries(questions)) {
    const reply = await models.completeSimple(model, {
      systemPrompt: `${instructions}\nReply with JSON only: {"answer": "yes" or "no", "confidence": 0.5 to 1}.`,
      messages: [{ role: "user", content: JSON.stringify(state), timestamp: Date.now() }],
    });
    if (reply.stopReason === "error") throw new Error(reply.errorMessage);
    const { answer, confidence } = JSON.parse(reply.content.find((part) => part.type === "text").text);
    if (!["yes", "no"].includes(answer) || !Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) {
      throw new Error(`the model answered out of shape: ${JSON.stringify({ answer, confidence })}`);
    }
    answers[name] = { type: "noul", noul: answer === "yes" ? confidence : 1 - confidence };
  }
  return { answers };
};
const report = await curate({ repo, judge });
```

An answer between the two cuts holds the candidate; nothing uncertain is accepted. `thresholds` overrides any cut,
`DEFAULT_THRESHOLDS` are the defaults above. A `used` mark counts one use per run for an active learning and needs no
judgment. A workflow is judged on itself, never on the agent's note. The note, the text of a `learn` call of type
`workflow`, is the draft's `README.md`: when the run wrote one, it passes the injection screen with the draft and is asked
a note's questions (`narrowsRules` when there are rules, `fromContent` when the run is untrusted, and `general`). One that
passes lands on main as the agent wrote it, with the workflow; one that is refused or held stays off main, the workflow is
judged as if it had none, and the run's report says so on the workflow's line. `narrowsRules` is not asked of the
workflow's document: a workflow is by design a slice of the job (it reads what it
reads and hands the rest back), so measured against rules written for the agent it always looks narrower, and it cannot
change the rules that bind the agent that runs it. Its draft is read back as the records the DSL's store writes for it, `workflowCase` is asked of
the document (one the store refuses, or one that runs code, goes straight to the hook, which refuses or holds it), and
then the records go to the `admitWorkflow` hook, with no description, which answers `admitted`
with the files to write under `workflows/<name>/` and `.agents/skills/<name>/`, `unchanged`, `held` or
`refused`. A run's `uses/<run id>.json` goes to the `settleUses` hook, which folds the uses into the workflows' trials
and answers the files to write and one decision per workflow (`promote`, `demote` or `hold`). Curation guards what
either hook returns, refuses a rules-tier path or any path outside the named workflows' folders, and holds a workflow
or the uses when its hook is turned off. Both ports (`AdmitWorkflow`, `SettleUses`, `RepoRead`, `WorkflowUse`) are
this package's types, and `workflowAdmitter()` and `usesSettler()` are their implementations: when `admitWorkflow` or
`settleUses` is omitted, curate uses them, so a host cannot forget the workflow pieces, and `null` turns one off. When the
`<learned>` section derived from the active learnings would pass 4,096 bytes, the least-used are archived first, this
run's new ones last, and the report names each. A workflow whose live revision changed gets its document,
`workflows/<name>/workflow.json`, beside its records, and the run's README when it passed, else, when main has none, a
`README.md` that points at its skill.

Run branches are read from `runs` when the host keeps them apart from main (a hidden namespace for runs, as
code.storage's ephemeral branches are); it defaults to `repo`. Curation only reads `runs` and only writes `repo`.

`caps` sets the section cap (`index`), the questions one run may ask (`questionsPerRun`, 128; past it the run's
remaining candidates are held) and the retries (`retries`, 5): a push that a moved main rejects is rebuilt from the new
main, judged answers reused, and after the last retry curation stops with `contended`. A judge that fails or answers out
of shape stops it with `judge` before that run is written. The report lists, per run, `accepted`, `superseded`,
`duplicates`, `used`, `held`, `refused`, `archived` and `settled`, each item with the candidate's position, the learning id and a
reason that names no value from the case.

Two ways take a learning out. A `git revert -m 1` of a curate merge on main undoes that run's learnings while nothing else
has touched their files, and the next curate does not bring them back: the run is still named in main's history. Once
a later run used a learning (its `uses` moved), the revert conflicts; then the host retires it:

```ts
await retireLearning({ repo, id: "L-3f2a9c1d0e7b", reason: "it sent runs to the wrong registry" });
```

`retireLearning` is an operator's act outside the loop, by the same single writer: one commit on main that sets the status to `retired`, keeps the file and its
history, carries `Retired-Learning: <id>`, and is pushed without force with the same retries. A retired learning is
never in `<learned>` again, and curate compares every new candidate with the retired learnings of its type, so a run
that learns it again in other words is held, naming the retired id. Retiring it twice changes nothing.

## Workflows

A workflow the agent saved with the DSL's `agentrun` tool is a candidate like a learning, and it earns its place on
receipts. The agent keeps writing it in its own working directory, where the tool's store lives. The host moves it between
that directory and the repository only through the DSL's public store, `@parcha/agentrun-pi/workflows`, and never parses a
record itself.

```ts
// At run start: what to try for this input, put in the run's own store so the agentrun tool finds it by name.
const hints = await workflowsToTry({ repo, sha }, input);
const seeded = await seedLearning({ repo, ref: sha, target: harness, into: workDir, workflows: hints });
const tried = await seedWorkflows({ repo, sha: seeded.sha, into: workDir, workflows: seeded.workflows });

// Before the agent says anything: serve what was proven, when it takes the job. `takes` and `check` are the host's.
const plan = await planServing({ repo, sha: seeded.sha, workDir, workflows: tried.loaded, takes });
const served = plan ? await serve({ harness, workflows: flow, context, plan, input, tools, check }) : undefined;

// At the run's terminal: with the working directory, the step collects what the run saved that the repository did not
// hold, and how it used what it had, and proposes them with the run's candidates. Explicit `workflows` or `uses` win.
// `read`, the untrusted text the run read, withholds a saved workflow that copies any of it.
await proposeLearning({ repo, runId, target: harness, workDir, untrusted: true, read: pages, served: served ? [served] : [] });

// In curate: the two ports are the defaults, so there is nothing to pass.
await curate({ repo, judge });
```

List every extension the agent's conversation needs in the root agent's extensions, including agentLearn and the workflow tool;
installing in the registry alone is not enough. The shape is `{ extensions: [learn.extension, workflowTool.extension] }`.

`proposeLearning({ workDir })` reads the run's uses from `target` when it is an open Session (a commit that only scans the
workflow tasks and writes nothing); pass `uses: usesSource({ store, workDir, run })` to read them from the run's store file
instead, or from the receipts of a pi session. Without a seed in `target` (`seedSha` overrides it) the baseline for "new" is
main.

**Admitting.** `workflowAdmitter` is the curator's `AdmitWorkflow` port. It copies main's `trial.json` and skill for the name
into a scratch directory, loads the run's records through the DSL's store there, which refuses a record whose name, metadata
or SHA-256 does not match, then saves the revision the run ended on (what `latest` names) through the store. It writes
`.agents/skills/<name>/SKILL.md` (its description is `describe` of the revision's document, by default `schemaDescription`:
the fields of its input and output, by name and type, with no text the agent wrote; a caller that hands over a
`description` gets that instead, and curate never does; the body says to run the workflow with the agentrun tool and to
continue the task itself if it escalates) and `trial.json`, and returns every
path changed, as text, or `null` where one was deleted, for the curator's one commit. The name must be a skill name:
lowercase letters and digits in words joined by single hyphens, because the skill folder carries it and pi refuses other
names (`refused`). A workflow with a code node, or a shell or executor call, is `held` unless the host passes
`allowExecutableCode`: nothing a person reviewed runs it. A record the store refuses, a demoted revision and the limits are
`refused`; the same revision and description again are `unchanged`. A revision admitted without a description is kept but
offered to no run until one arrives, and the skill that described the revision before it is withheld, not offered for the
new one (a call with no records describes an existing name).

**Standing.** `trial.json` holds `{ name, status, when, revisions, uses }`, and `refused` once it needs one (below). The new revision is the live trial under its
name. The revision it replaces is `superseded` if it was active, keeping its preconditions and the description of its skill
so a demotion can restore both, or `retired` if it never proved itself; only the 3 newest superseded revisions keep that. A
demoted revision stays in the list so it is never tried again. Only the live and restorable revisions count toward the
limit of 32: when admitting a new one would take the list past it, its retired and demoted revisions leave the list and
keep only their digests in `refused`, which are not admitted again either. `refused` keeps the newest 128: when it is full the
oldest leaves, with any kept use that names it, and may be tried again, so a full list never refuses an admission. A trial that keeps refusals
holds only its live and restorable revisions from then on. A name that churns through many revisions in a long stream so
keeps admitting new ones. `status` is that of the live revision, or `demoted` when there
is none. `when` is a list of typed checks on the run's input, each a JSON pointer and one of `eq`, `in`, `exists`, `gte`,
`lte` (numbers only: a string is never coerced), never a pattern over prose. The default is none, and the model decides from
the description; `workflowAdmitter({ when })` takes a function of the workflow document, and `schemaWhen` is one: what the
workflow's own input schema says about the top level of its input (each required property must exist, a constant must be
equal, an enumeration of scalars must contain the value, a number's bounds hold). `workflowsToTry` offers a name whose skill
and `trial.json` are at the commit, whose live revision is a trial or active and whose record is there, and whose checks hold
on the input: active first, then by name, at most 8. The file stays under the curator's cap at every limit: 32 revisions (or
the live and restorable ones beside 128 refused digests), 30 uses, 16 checks of at most 1,536 characters printed.

**Tenure.** With runs in flight side by side, a run that saves a new revision can report back before the runs that ran the
live trial do, and its revision would retire the trial before their uses count. `workflowAdmitter({ tenure })` takes where
the host's runs started (`started(run)`: the main commit each was prepared from and its place in the start order) and which
are still in flight (`inFlight()`: every run started whose curation has not committed; a run that reports stays in it until
the `curate` call that takes it returns, since curate takes reported runs by branch name, not start order, and a run that
crashed, was aborted or deadline-killed, or failed on its infrastructure leaves it at its end without reaching curate).
A history read that fails throws, so curate stops and the run is curated again later. The option is
opt-in: without it nothing changes. A new revision is then `held`, and the live trial kept, when the run that saved it
started before the trial was live (it never saw the trial), or while a run that started with the trial live, and before
it, is still in flight. A champion is never held. Each hold ends as the runs that started before the saving run report
back, so a trial no run uses cannot keep its name, and with no run in flight nothing is held. A held revision is not kept:
a later run may save it again.

**Serving.** The host can run a saved workflow itself, before the agent says anything, so a run a proven workflow finishes
costs no agent turn. `planServing` picks what to serve for the run: the live revision when it is active; while it is on
trial, the revision it superseded, the last one proven (a canary), read from the repository at `sha` and checked against its
digest, so the trial still earns its place through the agent; nothing for a first revision on trial. `takes(workflow)` is
the host's: whether the workflow takes this job, its input and the shape of its output. `serve` runs the plan as a durable
workflow task of the run, under the key `host:<name>:<sha256>:<input hash>` (`hostKey`, `hostRunName`), after the checks the
`agentrun` tool makes: no code node, no SOP text, only the host's `tools`, an input the workflow takes and no node that reads
a key the input lacks; a refusal writes no task. `check(output)` is the host's too: the problems with an output as the job's
answer, none when it is valid. A complete run `check` accepts is the run's answer; one it refuses is `escalated` with the
problems, so a workflow that returns what the job cannot use counts against itself. Anything else hands the job to the
agent; when the served revision was a canary, `trialFirstText({ name, served, trial })` is what to tell it: the trial is
named and asked to run first, the job done by hand only if it escalates too. Pass what was served to
`proposeLearning({ served })` (or `usesSource({ store, workDir, run, served })`): each served run is a use of its own
revision under its name, with the host's verdict, though the run's own store need not hold that revision. A canary's uses
never count toward the trial.

`planServing` stands on two pieces a host can use alone. `servingRevision(trial, { unrunnable })` says which revision to
run: the live revision when it is active; while the live revision is on trial, the most recent superseded revision that can
still run (`unrunnable` names those the host cannot load), with the trial named and `canary` true. A first trial, with
nothing proven before it, gives none, and a retired or demoted revision is never served. `readRevision(repo, name, sha256,
ref)` returns a revision's workflow from its record at a commit, through the DSL's store, undefined when the record is missing
or is not that revision; `planServing` passes over a superseded revision whose record does not read, for the one before it.

**Uses.** A use is one `agentrun.workflow` task in the run's store (`@parcha/agentrun-pi/durable`'s `createWorkflowExtension`),
read from the store file with `recordingLines` (one read transaction, never written; open or closed) or from the open Session. It counts when the
task's workflow has the digest of a revision the run's own store holds under a name. The outcome is `frozen` when the workflow
completed, `escalated` when a gate fired and the host's ladder took over, `failed` when the task failed or faulted. A task
that is not finished, was cancelled or was orphaned says nothing about the workflow and is named in `skipped`, and so is a use
of a name the skill folder cannot carry. A run key started again after a failure is one use, by its last task. The task's end
is the use's time. `uses/<run id>.json` is `{ version: 1, run, uses: [{ name, sha256, outcome, at }] }`. When the agent ran the
workflow with the `agentrun` pi tool in a pi session instead, `readSessionUses({ entries, workDir, run })` reads the same uses
from the receipts the tool leaves there (`agentrun:snapshot` entries; `sessionEntries` reads them from the session file): the
last snapshot of a run decides, so a run resumed after a failure counts only once it ends again; `complete` is `frozen`, an
`interrupted` run is left out, and the name is the one the tool saved or loaded the workflow under, when the run's store holds
that digest under it.

**Promotion.** `usesSettler` is the curator's `SettleUses` port: it copies main's `trial.json` of each name used, and the
records of its superseded revisions, into a scratch directory, and folds the run's uses in, appending each to its workflow's
`trial.json` and settling after each one (`settleWorkflowUses`, `foldUses`, `promotionDecision`). Promotion rests on
independent evidence: a run's uses of one revision are one use, the worst outcome winning (failed over escalated over frozen,
so one bad case in a run counts against the run), however many inputs the run gave it. A trial is promoted when its last 2
uses, which are 2 distinct runs, all finished `frozen`; the live revision is demoted when its last 2 uses, the last 2 runs that
used it, both failed or escalated, and the most recent superseded revision that the store can still load comes back, with `latest`, its preconditions and its skill's
description. With none to restore the name is demoted whole, its skill is deleted so the agent is no longer told about it, and
`trial.json` stays, so a demoted revision is never promoted or tried again; only a changed document, with a new digest, is
tried under the name again. A standing counts the uses folded since it began, in the order they were folded, never a clock: a
use that arrives after a decision counts toward the standing the decision gave, and a restored revision's failures from before
it was superseded never demote it again. Only the newest 30 uses are kept, and receipts for other revisions never push out the live
revision's own newest uses. The run that wrote a revision is no evidence for it, however many cases it ran, and a run already folded for a
revision is not folded again. The thresholds are the host's: `usesSettler({ thresholds: { promoteAfter, demoteAfter } })`,
1 to 15. A frozen workflow never fails a case: the agent is the fallback, and a use only moves the workflow's own standing.
The decisions come back one per promotion, demotion or name held, each with a reason that names no value from the case; a
`trial.json` that does not parse holds its name and never stops curation. Curation settles a run's uses BEFORE it admits the
workflows the run saved, and the admitter reads `trial.json` as the uses left it: a run that ran a trial cleanly and saved a
new revision of the same name has its use counted on the trial it ran (which a promotion then keeps restorable, superseded
under the new trial), never dropped.

## Versions

The pi-durable and chord peers accept 1.1 to 1.3.x. The suite runs on 1.1.0 in the workspace and on 1.2.0 and 1.3.0 in
the `pi-1-2` CI job, including a run killed with SIGKILL after `learn` committed and resumed from the same store.
