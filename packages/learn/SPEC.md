# Self-learning on any harness: the files

An agent learns in its own git repository, with its own harness's tools. After a run it writes a memo, then commits the
memo and any new notes, skills and workflow drafts to that run's own branch. A review step merges what passes into
`main`, and the next run reads `main`. This page is the contract: a repository layout, a memo format, a note format, the
rules, the caps and the merge policy. Any agent that can read, write and commit files can follow it, inside AgentRun or
not.

The risk it is built against: an agent reads untrusted pages, writes its own rules, and those rules merge without a
person. So a run's branch is checked twice before it merges. `agentrun-learn check` checks its structure, in code.
The review checks what it says: an injection screen, then the review skill's judgment.

## The layout

```
AGENTS.md                         the standing rules. Locked.
agent.json                        the agent's definition, when it has one. Locked.
learnings/INDEX.md                one line per active note. The first thing a run reads.
learnings/L-<12 hex>.md           one note: one general rule
.agents/skills/<name>/SKILL.md    a skill the agent wrote (the shared skills convention)
.agents/skills/reflect/           the loop's reflect skill. Locked.
.agents/skills/review/            the loop's review skill. Locked.
workflows/<name>/workflow.json    a drafted workflow, as the workflow DSL reads it
workflows/<name>/README.md        what the draft is for, and when it applies
memos/<run id>.md                 the memo of each run
```

A run's branch may change only the paths above that are not locked. Any other path is refused.

- A run id is 1 to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit, with no `..` and
  no trailing `.` or `.lock`, so `runs/<run id>` is always a valid branch name.
- A note id is `L-` and 12 lowercase hex digits.
- A workflow name is 1 to 64 lowercase letters, digits, dashes or underscores, starting with a letter or digit.
- A skill name is 1 to 64 lowercase letters, digits and single dashes, starting and ending with a letter or digit.

## Locked paths

A run's branch never adds, changes or deletes these, at any depth and in any spelling (letter case, Unicode
compatibility forms, ignorable characters, trailing dots or spaces, NTFS stream suffixes, 8.3 short names):

- `AGENTS.md` and `agent.json`: the agent's rules and definition;
- `.agents/skills/reflect/` and `.agents/skills/review/`: the loop cannot rewrite the review that merges it;
- the checker's config: `.agentrun/`, the host's tool list when the repository keeps it, and any path the host locks;
- hooks: `.githooks/`, `.husky/`, and the folder `core.hooksPath` names;
- `.github/`;
- `package.json`, whose scripts run;
- `SPEC.md`.

## Git

The checker reads git objects with plumbing only (`rev-parse`, `merge-base`, `diff-tree`, `ls-tree`, `cat-file`). It
never checks anything out, so no hook, filter, smudge or merge driver of the repository runs, and it turns off the
fsmonitor, the hooks folder, replace refs and lazy fetches. A run's branch holds regular files only:

- no `.gitattributes` and no `.gitmodules`, at any depth;
- no symlink, no gitlink (submodule) and no executable bit: every file is git mode `100644`;
- no Git LFS pointer;
- UTF-8 text, with no character a reader does not see: format and default-ignorable characters (zero-width, bidi
  controls, tag characters), private use, line and paragraph separators and control characters other than tab and
  newline. An emoji's joiners and variation selectors, and the joiners some scripts need between letters, are text.

## The caps

Over a cap is refused, never cut.

| What | Cap |
| --- | --- |
| One note file | 4096 bytes |
| New notes in one run | 8 |
| `learnings/INDEX.md` | 4096 bytes |
| One memo | 16384 bytes |
| Any other file | 32768 bytes |
| Changed paths in one run | 64; over it nothing else is read |

## The rules

- One branch per run, `runs/<run id>`. A run never writes to `main`.
- The branch carries its own memo, `memos/<run id>.md`, and changes no other run's memo.
- A run never deletes a note, the index or a memo. A note leaves use by its `status` (`superseded` or `retired`). A
  skill or a workflow draft may be deleted as a whole: a workflow folder that still holds a file holds both of its files.
- Every changed path but the memo and `learnings/INDEX.md` is named under the memo's `## Proposed changes`.
- No file holds text shaped like a secret (well-known key prefixes such as AWS, Google, GitHub, Slack and `sk-` keys,
  JSON web tokens, URLs with a password, and PEM private-key headers), or a value the host names as secret. Whether a
  note holds one case's data is the review's judgment, not the checker's.
- A workflow draft names only what runs on the workflow DSL on any harness: see [Workflow drafts](#workflow-drafts).

## The memo

```
---
run: 2026-10-27-0412-a1b2
base: 3f9c2e1a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e
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

The front matter holds facts, and the host writes it: the model writes only the four sections. One `key: value` per
line; a `#` after a space starts a comment.

| Key | Required | Value |
| --- | --- | --- |
| `run` | yes | the run id; the branch is `runs/<run>` |
| `base` | yes | the id of the commit of `main` the run started from, in full or its first 12 digits or more |
| `outcome` | yes | `completed`, `failed` or `stopped` |
| `harness` | no | a short lowercase name, for information only |
| `cost_usd` | no | a number of dollars, 0 or more |

The checker refuses a memo whose `run` is not the branch's, or whose `base` is not the commit the run started from (the
full id or a prefix of it): the commit the host names (`--run-base`), or else the branch's fork point from `main`.

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

`workflows/<name>/workflow.json` is one workflow document. Its `name` is the folder's name.
`workflows/<name>/README.md` says what it is for and when it applies, and is not empty.

Anything an agent learns on any harness must run on the workflow DSL. So:

- The DSL's own `validateWorkflow` judges the draft, with `executeCode: false` (a `code` node is syntax-checked and never
  run) and with the host's tool list as its `tools` option. Only the DSL's node types pass, and every tool a node names
  (a model or prose-artifact node's `tools`, a `call` node's `tool`, in a child workflow too) must be in the host's
  list. A refusal carries the validator's own issue: its code, the node's path and the message.
- A draft holds no `code` node and no `call` node with `via: "shell"` or `via: "executor"`, at any depth: it merges
  without a person, so it carries no way to run code. Code nodes run in the host process unless the host isolates them,
  and no host on the open platform does today; allowing an isolating host later is a deliberate change.
- The host's tool list is the one list of names a workflow can bind on any harness. Under AgentRun the server passes
  its tool table's names. A harness's built-in tool names (Codex's `exec_command`, Pi's `bash`, Claude Code's `Bash`)
  are not in it unless the host puts them there: a harness adapter maps its calls back to the host's names.
- The checker fails closed. With no host tool list, a draft that names any tool is refused with "no host tool list
  given: pass --tools <file> or run it under the host". A draft that names no tool checks without one.

## The merge policy

Everything that passes merges automatically: notes, the index, skills and workflow drafts alike. An agent may ask for a
person's approval at the merge step; that is the merge step's option, not the checker's.

Before every merge, in this order:

1. The checker passes on the run's branch.
2. The injection screen: every new or changed note, skill and workflow draft goes through the same page-injection screen
   a page the agent reads goes through, the host's `classifyPage` judge scored against `INJECTION_THRESHOLD` (0.75, from
   `@parcha/pi-browser`). A score at or over the threshold is refused. An item the screen could not judge (the judge is
   down, or timed out) is refused for this merge too, never held: a later run may propose it again.
3. The review skill reads what is left and merges what is general, new and consistent with `main`. It refuses
   duplicates, notes that contradict `main` without superseding the old note, and anything tied to one case.

Outside AgentRun, with no injection screen, nothing merges automatically: the checker alone never stands for the screen.

A merge is a merge commit on `main` whose message holds the review's verdict and its reason. `main` is never force-pushed
or rebased.

## What the checker reports

`{ ok, problems }`, with the run, the branch and its fork point when the checker reads a repository. `ok` means the
branch goes on to the injection screen and the review. Each problem names a rule and,
when there is one, the file; it never prints a value it refused.

| Rule | Meaning |
| --- | --- |
| `branch` | the branch is not `runs/<run id>`, or shares no history with the base |
| `too_many_files` | more than 64 changed paths |
| `locked` | a locked path |
| `git_file` | a `.gitattributes` or `.gitmodules` |
| `file_mode` | a symlink, a gitlink or an executable |
| `outside_layout` | a changed path the layout does not hold |
| `deleted` | a note, the index or a memo deleted |
| `too_large` | over a byte cap |
| `too_many_notes` | more than 8 new notes |
| `encoding` | not UTF-8 |
| `lfs_pointer` | a Git LFS pointer |
| `invisible_unicode` | a character a reader does not see, by code point |
| `secret_shape` | text shaped like a secret, by kind |
| `secret_value` | a value the host named as secret |
| `memo_missing` | the branch carries no memo of its own |
| `memo` | the memo's front matter or sections are out of shape |
| `memo_run` | the memo's `run` is not the branch's |
| `memo_base` | the memo's `base` is not the commit the run started from |
| `memo_unlisted` | a changed file the memo's `## Proposed changes` does not name |
| `other_memo` | a change to another run's memo |
| `note` | a note out of shape, or whose id is not its file name |
| `note_run` | a new note that does not name this run |
| `index` | an index line out of shape, or a note named twice |
| `index_note` | an index line naming a note that is not on the branch |
| `skill` | a skill out of shape |
| `workflow` | a draft the DSL refuses (a tool outside the host's list among them), not named for its folder, or incomplete |
| `no_tool_list` | a draft names a tool and the host gave no tool list |
| `executable_node` | a draft holds a code node, or a call node via shell or executor |
