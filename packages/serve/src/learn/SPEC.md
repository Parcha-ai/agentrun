# An agent's learning folder: the contract

An agent's memory is a folder of short markdown notes in Claude Code's own auto-memory format, kept by its host. Every
run reads the folder's index in its instructions and finds the notes in a copy of the folder. When a run ends, the host
may ask it one more turn, in which it may add notes to its copy. The host checks what it added, one grader judges it,
and the host merges it into the folder. This page is the contract: the format, what a run may propose, the checks, the
caps and the merge. The code is the server's own, beside this page: `notes.ts` (the format), `check.ts`
(the checks), `reflect.ts` (the end-of-run prompt) and `grade.ts` (the rubric, the grader's prompt and its verdict).
None of it runs git or calls a model: the rest of the server does both.

The risk it is built against: an agent reads untrusted pages, writes its own notes, and those notes reach every later
run without a person. So what a run proposes is checked twice before it merges: its structure in code (`checkProposal`),
then what it says by one grader (`GRADE_RUBRIC`).

## The folder

```
MEMORY.md                 the index the next run reads: one line per active note, built by the host
refund-policy-path.md     one note per file
prefers-tables.md
```

The folder is plain git with one branch, `main`; git is its history and its undo. The host is its only writer: no run
writes it, and nothing in it runs.

## A note

```
---
name: Refund policy path
description: Shopify stores keep their policies at /policies/
type: reference
---
Open /policies/ before searching the store.
```

The file is `<slug>.md` at the folder's top: 1 to 96 letters, digits, dots, dashes or underscores, starting with a
letter or digit, then `.md`, and never `MEMORY.md`.

| Key | Required | Value |
| --- | --- | --- |
| `name` | yes | a short title |
| `description` | yes | one line that says when the note applies; it is the note's index line |
| `type` | yes | `user`, `feedback`, `project` or `reference`, Claude Code's four |
| `supersedes` | no | the notes it replaces, `[old.md, other.md]` or one bare file name |
| `status` | no, host only | `superseded` or `retired`; absent, the note is active |
| `superseded_by` | no, host only | the note that replaced it, on a superseded note |

One `key: value` per line, a value bare or in one pair of quotes. Keys it does not know are left alone. The body after
the front matter is the memory itself.

## The index

`MEMORY.md` is one line per active note, by file name, `- [name](file.md) — description`, built by the host from the
notes' front matter every time it merges. A run reads its first 200 lines, within 25 KB, as Claude Code loads its own.

## What a run may propose

When a run ends, its copy of the folder (the active notes and the index, as the run started) may hold new files. The
host compares the copy with the commit the run started from, reading only regular files and never following a link.
A run may only add notes:

- one file per new note, in the format above, at the folder's top;
- to replace a note, a new note whose `supersedes` names it; the old one stays, and the host marks it;
- never an edit or a deletion of a file that was there, and never `status` or `superseded_by`, which are the host's;
- `MEMORY.md` is the host's: a change to it is ignored, never refused.

Writing nothing is a fine answer: the host drops it as `empty`.

## The caps

Over a cap is refused, never cut.

| What | Cap |
| --- | --- |
| One note | 4096 bytes |
| New notes in one run | 8 |
| Notes one run's new notes supersede, together | 8 |
| Active notes after the merge | 200, the index's lines |
| Changed paths in one run | 64; over it nothing else is read |

## The checks

`checkProposal` refuses, before anything is written to git:

| Rule | Meaning |
| --- | --- |
| `too_many_files` | more than 64 changed paths |
| `outside` | a path that is not a `.md` file at the folder's top |
| `file_name` | a `.md` file whose name is not a note's |
| `file_mode` | a link, a folder or anything else that is not a regular file |
| `encoding` | not UTF-8, in a file or its name |
| `edited` | a file that was there, changed |
| `deleted` | a file that was there, gone |
| `exists` | a new file whose name the folder holds, a superseded note's included |
| `too_large` | a note over 4096 bytes |
| `too_many_notes` | more than 8 new notes |
| `invisible_unicode` | a character a reader does not see, by code point |
| `secret_shape` | text shaped like a secret, by kind, in a note or its name |
| `secret_value` | a value the host holds as secret, in a note or its name |
| `note` | front matter missing or out of shape |
| `status` | a note that sets `status` or `superseded_by` |
| `supersedes` | `supersedes` naming a note that is not active, or one another new note supersedes too, or more than 8 notes superseded |
| `index_full` | the index would pass 200 lines |

- A character a reader does not see: format and default-ignorable characters (zero-width, bidi controls, tag
  characters), private use, line and paragraph separators and control characters other than tab and newline. An
  emoji's joiners and variation selectors, and the joiners some scripts need between letters, are text.
- Text shaped like a secret: well-known key prefixes such as AWS, Google, GitHub, Slack and `sk-` keys, JSON web
  tokens, URLs with a password, and PEM private-key headers. A value the host holds counts as written, as JSON writes
  it, percent or form encoded, in base64 or in hex.
- Every problem is `{ rule, path?, detail }`, printable as it is: its path and detail are cut of the host's values and
  of secret shapes, and a field over 4096 bytes prints whole as `[redacted]`, never scanned.

Whether a note holds one case's data is the grader's judgment, not the checker's.

## The grade

One grader judges the whole proposal against the agent's active notes and standing instructions, with `GRADE_RUBRIC`
(`grade.ts`, the rubric's one statement), on the agent's own model. `gradePrompt` fences, as data, the
instructions (their first 16,000 characters), the index line of each active note (cut to 300 characters), the whole
text of only the notes the proposal supersedes, and the new notes. So the prompt is bounded by the caps above, never by
how many notes the folder holds: `GRADE_CAPS.prompt`, 200,000 characters, half what a completion takes.
`parseVerdict` reads one verdict with one item per new note and fails closed: an answer it cannot read, a missing or
extra item, or a merge with a note not kept is no merge. Every note merges, or none does.

A separate injection screen is the host's option, only with a judge independent of the agent's model.

## The merge

One host commit on `main`, made with plumbing: the new notes added, each note a new one supersedes marked
`status: superseded` with `superseded_by`, and `MEMORY.md` rebuilt. Its message is `learning: <run id>: merged`, the
grader's reason, and a `Run-Id: <run id>` trailer; a run a trailer on `main` already names is merged, never twice.
`main` moves only from the commit the merge was made on. Before it, the host asks `mergeProblems` again of `main` as it
is then: a name another run added since is `exists`, and a note superseded since or an index past 200 lines is refused
as above. A note is never deleted: a retired or superseded note stays in the folder and leaves the index.
