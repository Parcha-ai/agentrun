# Self-learning on any harness: the files

An agent learns in its own git repository, with its own harness's tools. After a run it writes a memo, then commits the
memo and any new notes, skills and workflow drafts to that run's own branch. A review step merges what passes into
`main`, and the next run reads `main`. This page is the contract: a repository layout, a memo format, a note format, the
rules and the caps. Any agent that can read, write and commit files can follow it, inside AgentRun or not.

`agentrun-learn check` validates a run's branch against this page before any merge. It is structural only: whether a
note is any good is the review skill's judgment, never the checker's.

## The layout

```
AGENTS.md                         the standing rules. Never touched by the loop.
agent.json                        the agent's definition, when it has one. Never touched by the loop.
learnings/INDEX.md                one line per active note. The first thing a run reads.
learnings/L-<12 hex>.md           one note: one general rule, never one case's data
.agents/skills/<name>/SKILL.md    a skill the agent wrote (the shared skills convention)
workflows/<name>/workflow.json    a drafted workflow, as the workflow DSL reads it
workflows/<name>/README.md        what the draft is for, and when it applies
memos/<run id>.md                 the memo of each run
```

A run's branch may change only these paths. `AGENTS.md` and `agent.json` are never changed, at any depth and in any
spelling (case, Unicode compatibility forms, ignorable characters, trailing dots or spaces). Every changed file is a
regular file (git mode `100644`): no symlink, no executable, no submodule. Every file is UTF-8.

- A run id is 1 to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit, with no `..` and
  no trailing `.` or `.lock`, so `runs/<run id>` is always a valid branch name.
- A note id is `L-` and 12 lowercase hex digits.
- A workflow name is 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit.
- A skill name is 1 to 64 lowercase letters, digits and single dashes, starting and ending with a letter or digit.

## The rules

- One branch per run, `runs/<run id>`. A run never writes to `main`; `main` changes only by merge.
- The branch carries its own memo, `memos/<run id>.md`, whose `run` is the branch's run id and whose `base` is the
  commit of `main` the branch starts from. It changes no other run's memo.
- A run never deletes a note, the index or a memo. A note leaves use by its `status` (`superseded` or `retired`).
  A skill or a workflow draft may be deleted, as a whole: a workflow folder that still holds a file holds both of its
  files.
- Every changed path but the memo and `learnings/INDEX.md` is named under the memo's `## Proposed changes`.
- Notes are general rules. They never hold a customer's data or a secret. No file holds text shaped like a secret
  (well-known key prefixes such as AWS, Google, GitHub, Slack and `sk-` keys, JSON web tokens, URLs with a password, and
  PEM private-key headers), and none holds a value the host names as secret.
- A workflow draft names only what runs on the workflow DSL on any harness: see [Workflow drafts](#workflow-drafts).

## The caps

Over a cap is refused, never cut.

| What | Cap |
| --- | --- |
| One note file | 4096 bytes |
| New notes in one run | 8 |
| `learnings/INDEX.md` | 4096 bytes |
| One memo | 16384 bytes |
| Any other file | 32768 bytes |

## The memo

```
---
run: 2026-10-27-0412-a1b2
base: 3f9c2e1
harness: codex
outcome: completed
cost_usd: 0.42
---
## What happened
Two or three sentences.

## What I learned
- New note learnings/L-7c21e0a4b9d3.md: Shopify stores keep their policies at /policies/.
- Confirmed learnings/L-0a93ff12c4e7.md (it held again).

## What could be better
- I read 9 pages to find the refund policy; the footer links would have taken 2.

## Proposed changes
- learnings/L-7c21e0a4b9d3.md (new)
- workflows/find-policies/ (new draft)
```

Front matter, one `key: value` per line; a `#` after a space starts a comment.

| Key | Required | Value |
| --- | --- | --- |
| `run` | yes | the run id; the branch is `runs/<run>` |
| `base` | yes | 7 to 64 lowercase hex digits: a prefix of the `main` commit the run read |
| `outcome` | yes | `completed`, `failed` or `stopped` |
| `harness` | no | a short lowercase name, for information only |
| `cost_usd` | no | a number of dollars, 0 or more |

Then the four sections, each once, in this order and no other: `## What happened` (not empty), `## What I learned`,
`## What could be better`, `## Proposed changes`. Under `## Proposed changes`, each line `- <path>` names one changed
file, or a folder ending in `/` that holds changed files; text after the path is free.

## A note

```
---
id: L-7c21e0a4b9d3
type: lesson
status: active
runs: [2026-10-27-0412-a1b2]
supersedes: []
---
Shopify stores keep their policies at /policies/; try that path before searching.
```

| Key | Required | Value |
| --- | --- | --- |
| `id` | yes | the note id; the file is `learnings/<id>.md` |
| `type` | yes | `lesson`, `fact` or `correction` |
| `status` | yes | `active`, `superseded`, `archived` or `retired` |
| `runs` | yes, here or as `provenance.runs` | the runs that proposed or confirmed it, a list of run ids |
| `supersedes` | yes | the notes it replaces, a list of note ids, never its own |
| `scope` | no | `all`, or a short lowercase name of the inputs it applies to |
| `provenance` | no | nested `runs`, `sha` (a commit id), `untrusted` (`true` or `false`) and `shaFrom` (`branch-base`) |
| `uses` | no | how many runs marked it used, a whole number |
| `supersededBy` | no | the note that replaced it, on a `superseded` or `retired` note |

A list is `[a, b]`, its items bare or in double quotes. The optional keys are the Pi learning loop's, so a note it
wrote is a valid note here. A note this run adds names this run in its runs. The body after the front matter is the
rule: not empty, no carriage return.

## The index

`learnings/INDEX.md` is one line per active note, `- L-<12 hex>: <the rule in one line>`. Blank lines and lines that
start with `#` are allowed. Each note id appears once and names a note file on the branch.

## A skill

`.agents/skills/<name>/SKILL.md` starts with front matter that holds `name`, equal to the folder's name, and a
`description` that is not empty. Other keys are free.

## Workflow drafts

`workflows/<name>/workflow.json` is one workflow document, as the workflow DSL's `validateWorkflow` reads it, checked
without running any code it holds. Its `name` is the folder's name. `workflows/<name>/README.md` says what it is for and
when it applies, and is not empty.

Anything an agent learns on any harness must run on the workflow DSL. So a draft names nothing harness-specific:

- only the DSL's node types (`validateWorkflow` refuses any other);
- only tools from AgentRun's shared tool layer, the names a workflow can bind on any harness: by default the `shared`
  list in [`tools.json`](tools.json), which a host may replace with its own;
- never a harness's built-in tool name, in any case: the `harnesses` lists in `tools.json`, such as Codex's `shell`,
  `exec_command` and `apply_patch`, Pi's `bash`, `read`, `write` and `edit`, and Claude Code's `Bash`, `Read`, `Edit`,
  `Write` and `WebFetch`. A host may add names to these lists and never remove one; a built-in name is refused even when
  a host's shared list holds it.

## What the checker reports

Each problem names a rule and, when there is one, the file. It never prints a value it refused.

| Rule | Meaning |
| --- | --- |
| `branch` | the branch is not `runs/<run id>`, or shares no history with the base |
| `untouched` | a change to `AGENTS.md` or `agent.json` |
| `outside_layout` | a changed path the layout does not hold |
| `file_mode` | not a regular, non-executable file |
| `deleted` | a note, the index or a memo deleted |
| `too_large` | over a byte cap |
| `too_many_notes` | more than 8 new notes |
| `encoding` | not UTF-8 |
| `secret_shape` | text shaped like a secret, by kind |
| `secret_value` | a value the host named as secret |
| `memo_missing` | the branch carries no memo of its own |
| `memo` | the memo's front matter or sections are out of shape |
| `memo_run` | the memo's `run` is not the branch's |
| `memo_base` | the memo's `base` is not the commit the branch starts from |
| `memo_unlisted` | a changed file the memo's `## Proposed changes` does not name |
| `other_memo` | a change to another run's memo |
| `note` | a note out of shape, or whose id is not its file name |
| `note_run` | a new note that does not name this run |
| `index` | an index line out of shape, or a note named twice |
| `index_note` | an index line naming a note that is not on the branch |
| `skill` | a skill out of shape |
| `workflow` | a workflow draft that does not parse or validate, is not named for its folder, or is incomplete |
| `harness_tool` | a workflow draft names a harness's built-in tool |
| `unknown_tool` | a workflow draft names a tool outside the shared tool layer |
