# @parcha/pi-agent-learn

An agent that learns in its own git repository. While it works, the agent notes what would help a later run with one
tool, `learn`, which costs nothing. The host proposes those notes on the run's branch, a curator merges the good ones to
`main`, and every later run reads them in a short `<learned>` section of its prompt, taken from the commit it was seeded
from. A bad lesson is undone with `git revert`, and history keeps it.

It builds on [`@parcha/pi-git-remote`](../pi-git-remote), which owns git, and on pi-durable, which owns the run. The
host owns git: no model tool commits or pushes, and the repository's `.git` is never in the agent's working directory.

This package is held: it is built and tested in this repository and not published yet. This release has the contract
the model sees, the host step that seeds a run, the guard every write goes through, and the host step that proposes a
run's notes. Curation and workflow trials come next, on the types this release fixes (`Guard`, `Candidate`,
`WorkflowHint`).

## Quickstart (no key, no network)

Node 22.19 or later and git 2.40 or later. In a checkout of this repository, run `npm ci --ignore-scripts` and
`npm run build -w @parcha/pi-agent-learn`, save this as `quickstart.mjs` at the repository root, and run
`node quickstart.mjs`. The model is pi-ai's scripted faux provider.

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
  .pi/agentrun/workflows/<name>/   saved workflows, in the DSL's own layout
  learnings/<id>.md                one learning per file
  inbox/<run id>.md                a run's candidates, on runs/<run id> only
  inbox/<run id>/workflows/<name>/ a workflow the run saved, the DSL's records byte for byte, on runs/<run id> only
  uses/<run id>.json               a run's workflow uses, on runs/<run id> only
  inbox/<run id>/workflows/<name>/ a run's saved workflow records, as the DSL wrote them, on runs/<run id> only
```

`RULES_LOCKED` is the frozen list `["agent.json", "AGENTS.md"]`. `isRulesLocked(path)` is true for either name in any
segment of a path and in any spelling a file system or git could treat as the same file (case, Unicode compatibility
forms, ignorable characters, trailing dots or spaces, an NTFS stream suffix, an 8.3 short name). `assertNotRulesLocked`
throws for such a path; every writer calls it. `LAYOUT`, `tierOf`, `runBranch`, `inboxPath`, `usesPath`, `learningPath`
`inboxWorkflowDir`, `WORKFLOW_NAME` and `CAPS` fix the rest of the layout and its size caps.

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

`renderLearning` writes exactly this and `parseLearning` reads nothing looser: an unknown, missing or repeated key, or a
value out of shape, is a `LearnError` with code `format`. `learningId(runId, text)` is `L-` and 12 hex digits of SHA-256
over the run id and the text, so curating the same candidate twice cannot make two learnings.

## What the model sees

| Tool | Arguments | Returns |
| --- | --- | --- |
| `learn` | `{ type: "lesson" \| "fact" \| "correction" \| "used" \| "workflow", text, evidence?: string[], id?: string }` | `[noted <n>]` |

`learn` writes one candidate into the run's own pi-durable store (the session document `learn.candidates`), keyed by the
call id, inside the tool's commit. It is replay-safe: a call rerun after a crash finds its candidate and stores nothing
new. It makes no model call. A `used` mark names the learning that helped by its id. A `workflow` note names a workflow
the run saved (its name, by the DSL's rule: 1 to 64 lowercase letters, digits, dashes or underscores) and says in its
text when to use it; a correction, lesson or fact may name the learning it replaces. Text is at most 1,000 bytes and
evidence 1,000 bytes in all; a run makes at most 8 notes of every type but `used`, and 32 `used` marks. Evidence stays with the run and is
never part of a learning. `agentLearn({ guard, secrets })` checks every call with the host's guard first; a refused call
stores nothing and its result names the reason, never the value. The result carries its text under both `content` and
`output`, so pi-durable 1.1, 1.2 and 1.3 all show it to the model.

The `<learned>` section says that the rules win, lists the active learnings at the seeded commit (most used first, the
first line of each), names the workflows to try for this input, and tells the agent when to call `learn`. It renders
from the run's `learn.seed` record, so it is the same on every request of a run and the same for every run seeded from
one commit. It holds at most 4,096 bytes: learnings that do not fit are not loaded, the section says how many, and their
ids are in the record. A learning whose first line holds the section's tag is never loaded. Without `learn` among the
agent's tools, the lines that ask it to call `learn` are left out.

## Host steps

```ts
const seeded = await seedLearning({ repo, ref: "main", target: harness, into: run.workspace, workflows });
const extension = agentLearn({ guard, secrets: () => vault.values() });
const candidates = await collectCandidates(harness);
```

`seedLearning` fetches, resolves `ref`, reads `learnings/*.md` at that commit, derives the index under the cap, records
`{ sha, index, omitted, workflows, copied }` in the run's store as `learn.seed`, and copies the active learnings to
`<into>/.agent/learnings/<id>.md` for the agent to read. Each copy is written to a temporary file and renamed over the
name, so an interrupted copy never leaves a partial file, and seeding again restores the stored bytes over an edited copy
or a link. Edits there are never committed. A file
that is misnamed, does not parse, is a symlink or is over 4 KB is skipped and named in `skipped`. A run is seeded once:
when its store already holds a seed, that commit is used again and the record is kept, so a restarted host never moves a
run to a newer commit. `readSeed` returns the record; `collectCandidates` returns the run's candidates in order.
`workflows` is a list of `{ name, status: "trial" | "active" }`, at most 8; it is empty until workflow trials land.

With [`@parcha/pi-durable-agent`](../pi-durable-agent), the run starts at the same commit: the host reads `agent.json` and
`.agents/skills/` at the sha with `repo.read` and `repo.list`, keeps the agent home on it (`createAgentHome(dir, {
definition, skills, sha })`, then `refreshAgentHome(home, { sha, from, definition, skills })` when main moves), starts the
run with `startRun(home, { host, sha })`, and seeds it with `seedLearning({ repo, ref: started.sha, target, into:
started.workspace })`. The runs index, `learn.seed` and the section then all name that sha.

Every failure is a `LearnError` with a `code`: `invalid`, `format`, `missing`, `rules_locked` or `too_large`.

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
| `case_data` | Any value of 4 or more characters from `caseValues`, matched without case, over Unicode compatibility forms and with whitespace ignored (a value split by a line break is still found), in a text or a path. A learning states the rule, never the case. |
| `rules_locked` | `AGENTS.md` and `agent.json` for every role, in any spelling (`isRulesLocked`). |
| `path_not_allowed` | A path outside the role's own, any `.git` segment in any spelling, and a path that is not a plain relative one (`..`, `.`, `//`, a backslash, an absolute path, a control character). |
| `too_large`, `too_many` | Over a cap in `CAPS`: bytes per text, per evidence list, per file, per inbox; files per write; new learnings and `used` marks per run. A refused write is never truncated. |
| `invalid` | A run id, role, type, id or secret that is not well formed. |

A run writes `inbox/<run id>.md`, `uses/<run id>.json`, and the DSL's saved workflow records as they are,
`inbox/<run id>/workflows/<name>/<sha256>.json` and `inbox/<run id>/workflows/<name>/latest` (`<name>` is a workflow
name, `WORKFLOW_NAME`: 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit), and nothing else. The
curator writes `learnings/L-<12 hex>.md` (it names every entry by its generated id; the index is derived at seed time and
never stored, so `learnings/INDEX.md` is refused), `.agents/skills/<name>/SKILL.md` and `trial.json` (no other file or
folder in a skill folder), and the DSL's workflow records, `.pi/agentrun/workflows/<name>/<sha256>.json` and `latest`.
`trial.json` is the host's, so a
run that proposes one is refused.

## Proposing a run's notes

```ts
const result = await proposeLearning({ repo, runId, target: harness, secrets: vault.values(), caseValues, workflows });
```

`proposeLearning` is the host step at a run's terminal. It collects the run's candidates, renders `inbox/<run id>.md`
(and `uses/<run id>.json` from the optional `uses` hook, which a later part supplies), adds the workflow records the
host collected from the run's DSL store (`workflows`: per name, `{ files: { "<sha256>.json": text, latest: text } }`,
committed byte for byte under `inbox/<run id>/workflows/<name>/`; a name or file name of any other shape refuses the
proposal), guards the whole proposal as the
`run` role, and makes one commit on `runs/<run id>` through `@parcha/pi-git-remote` with a `Run-Id` trailer, pushed by
sha. The result is one of:

- `{ status: "proposed", sha }`: the commit was made and pushed.
- `{ status: "already", sha }`: the branch already held a commit for this run, from this host or a restarted one with an
  empty local repository; none was made, and the push is repeated so a crash between commit and push heals.
- `{ status: "empty" }`: the run noted nothing.
- `{ status: "refused", refusals }`: any guard hit refuses all of it, and nothing is committed or pushed, so no ref or
  object holds the refused value.

A push the remote refuses throws a `GitRemoteError`. `proposeFiles` is the same guard-commit-push for files the caller
has already rendered. `renderInbox` and `parseInbox` are the inbox's format: front matter (the run, and `seed`, the commit the run was seeded from,
read from its `learn.seed` record, so a curator can stamp a learning with what the run actually saw; a run that was not
seeded has none), the candidates for a person to read, and the candidates as one JSON line in the last fenced block, each
with an `untrusted` mark. `proposeLearning({ untrusted: true })` marks every candidate untrusted: the host sets it when the run read
untrusted content. `parseInbox` returns `{ run, seed?, candidates }` with `untrusted: boolean` on each candidate, and
refuses a seed that is not a commit id.

## Versions

The pi-durable and chord peers accept 1.1 to 1.3.x. The suite runs on 1.1.0 in the workspace and on 1.2.0 and 1.3.0 in
the `pi-1-2` CI job, including a run killed with SIGKILL after `learn` committed and resumed from the same store.
