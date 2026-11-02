# @parcha/agentrun-learn

Self-learning on any harness, as files. An agent's memory is a folder of short markdown notes in Claude Code's own
auto-memory format: `MEMORY.md`, the index, and one file per note. Every run reads the index; when a run ends, its host
may ask it one more turn to add notes. This package is the contract, in [SPEC.md](SPEC.md), and the code a host needs
around that turn: the format, the prompt, the checker of what a run proposes, and the grader's prompt and verdict. It
runs no git and calls no model: the host does both.

It is held: it is built, tested and verified with the other packages and is not on npm yet. Install it from a packed
tarball (`npm pack -w @parcha/agentrun-learn`).

## Notes

```js
import { activeNotes, buildIndex, loadedIndex, parseNoteFile, retire, supersede } from "@parcha/agentrun-learn";

const note = parseNoteFile("refund-policy-path.md", text); // { file, name, description, type, status, superseded_by, supersedes, keys, body }, or why not
const active = activeNotes(notes); // the active ones, by file name
const index = buildIndex(notes); // "- [name](file.md) — description\n" per active note; "" with none
const read = loadedIndex(index); // what a run reads: the first 200 lines, within 25 KB
const marked = supersede(oldText, "refund-v2.md"); // the old note with status: superseded and superseded_by
const gone = retire(text); // a person's retire: status: retired, and no superseded_by
```

## Asking a run what it learned

```js
import { reflectPrompt } from "@parcha/agentrun-learn";

const prompt = reflectPrompt({ dir: ".learning", active: activeNotes(notes).length });
```

Once a run has answered or failed, a host sends `prompt` as one more turn in the same session. It says where the
run's copy of the folder is, the format of a note, that a memory is replaced by a new note with `supersedes`, never
edited or deleted, that the host rebuilds `MEMORY.md`, how many index lines are left, that writing nothing is fine, and
what not to keep. It names no harness's tool. `dir` is the copy's path relative to the run's workspace, where every
harness's file tools resolve one, so the prompt holds no path of the host's, which a box would not see. It refuses an
absolute `dir`, and a control or unseen character in it.

## Checking what a run proposes

```js
import { checkProposal } from "@parcha/agentrun-learn";

const { ok, problems, notes } = checkProposal({
  base: { files: pathsAtTheRunsSeed, active: activeNotesAtTheRunsSeed },
  changes: [{ path: "refund-policy-path.md", status: "added", mode: "100644", bytes }],
  refuseValues: hostSecrets,
});
```

The host reads the run's copy itself, regular files only and never following a link, and hands the checker each change
against the commit the run started from. `ok` means the new notes (`notes`, parsed, with their text) go to the grader;
each problem is `{ rule, path?, detail }`, printable as it is. [SPEC.md](SPEC.md#the-checks) lists the rules.
`mergeProblems(base, notes)` asks the merge's own questions again of `main` at merge time.

`checkNote(path, bytes, refuseValues)` checks one note by itself, as a person writes it through the host: its name, the
4096-byte cap, UTF-8, hidden characters, secret shapes and the host's values, and its front matter. It answers
`{ problems, note? }`. A person may set `status` and `superseded_by`; what only a run may not do is `checkProposal`'s.

## Grading it

```js
import { gradePrompt, parseVerdict } from "@parcha/agentrun-learn";

const prompt = gradePrompt({ run: run.id, instructions: agent.instructions, active: mainActiveNotes, superseded, proposed: notes });
const verdict = parseVerdict(await grader(prompt), notes); // { merge, reason, items: [{ file, keep, question?, why }] }
```

`active` is every active note on `main` as the index lists it (`{ file, name, description }`, so a parsed note will
do); `superseded` and `proposed` are `{ file, text }`: the whole text of each active note the new notes supersede, and
of no other, and the new notes. The prompt holds `GRADE_RUBRIC`, the rubric's one statement, and fences the
instructions, the index lines and each note as data to judge, never to follow: the fence's token is one no fenced text
holds, so no text can close its fence. It asks for one JSON verdict with one item per new note. Its size is bounded by
construction (`GRADE_CAPS`): the instructions cut to 16,000 characters, each index line to 300, at most 8 superseded
and 8 new notes of at most 4096 bytes each, so it stays under 200,000 characters whatever the folder holds.

`parseVerdict` fails closed. It reads one JSON object, alone, in prose or in one fenced block. Two objects, a key
repeated in one object, a missing item, an item named twice or for a file the grader was not asked about, and `merge`
with an item not kept are each no merge; so is an answer it cannot read. The reason and each `why` come back as one
line of at most 500 characters, with control and unseen characters gone. `gradePrompt` throws on input no checked
proposal holds, and `parseVerdict` never throws on the grader's answer.
