# An agent's learning folder: the contract

An agent's memory is a folder of short markdown notes in Claude Code's own auto-memory format, kept by its host. Every
run reads the folder's index in its instructions and finds the notes in a copy of the folder. When a run ends, the host
may ask it one more turn, which answers with the notes it would keep. The host checks them, one grader judges them,
and the host merges it into the folder. This page is the contract: the format, what a run may propose, the checks, the
caps and the merge. The code is the server's own, beside this page: `notes.ts` (the format), `check.ts`
(the checks), `reflect.ts` (the end-of-run prompt and the parser of its answer) and `grade.ts` (the rubric, the grader's prompt and its verdict).
None of it runs git or calls a model: the rest of the server does both.

The risk it is built against: an agent reads untrusted pages, writes its own notes, and those notes reach every later
run without a person. So what a run proposes is checked twice before it merges: its structure in code (`checkProposal`),
then what it says by one grader (`GRADE_RUBRIC`).

## The folder

```
MEMORY.md                         the index the next run reads: one line per active note, built by the host
refund-policy-path.md             one note per file
prefers-tables.md
skills/find-policies/SKILL.md     a skill: how to do a job the agent does again
workflows/find-policies/          a workflow draft: its workflow.json and its README.md, together
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
| `type` | no | `user`, `feedback`, `project` or `reference`, Claude Code's four; absent, `project` (the merge adds no line: the host's lines stay within the cap's 28 bytes) |
| `supersedes` | no | the notes it replaces, `[old.md, other.md]` or one bare file name |
| `status` | no, host only | `superseded`, `retired` or `pending` (a risky rule, waiting for its owner's OK); absent, the note is active |
| `superseded_by` | no, host only | the note that replaced it, on a superseded note |
| `origin` | no, host only | `you`, kept from what the user asked in their own words, or `run`, what the run worked out; absent, `run` |

One `key: value` per line, a value bare or in one pair of quotes. Keys it does not know are left alone. The body after
the front matter is the memory itself.

## A skill and a workflow draft

A skill is `skills/<name>/SKILL.md`, alone in its folder: front matter whose `name` is the folder's name and whose
`description` says when to use it, then the steps. Its name is the shared skills convention's: 1 to 64 lowercase
letters, digits and single dashes. A run adds or changes at most one skill, and only when its job completed: a skill is
what every later run reads as how to do the job, so only a run that did the job writes one. `status` is the host's: a
skill the grader holds for its owner's OK says `status: pending` (`held`), and no run is given it until it is approved
(`isHeld`).

One front-matter reader decides what a skill's `SKILL.md` and a draft's `README.md` say of themselves (their keys, name,
description and status) for the checks, the folder's snapshot, the routes and a run's start alike. A front matter that
does not read one way (not closed, a key indented under another, an indented first line, a key set twice, a YAML
explicit key) or a status other than `active`, `pending` or `retired` reads as retired: no run is given it, a restore of
it is refused until it reads one way, and a run's skill or draft with such a front matter is refused at its end. A
status is one plain line; one that runs on over more lines reads as retired too. A learned skill is served with its
`name` and `description` quoted, so a harness reads them as text.

A workflow draft is `workflows/<name>/workflow.json` and `workflows/<name>/README.md`, both or neither; its name is 1
to 64 lowercase letters, digits, dashes and underscores, starting with a letter or digit. The host writes the README
from the one-line description the draft's block gives (`draftFiles`): front matter with the folder's `name` and that
`description`, and `status: pending` when the grader holds the draft. A run adds or changes at most one draft. The workflow DSL's own
`validateWorkflow` judges the draft, with no code run (`executeCode: false`) and the agent's tools as the list a node may
name: the tools its definition grants that a workflow's call node runs on this server, so a harness's own tool
(`Bash`, `exec_command`, `apply_patch`) is never on it, nor is a tool the gate does not allow (set to ask or deny, under the
server's tool settings and the agent's own): a draft whose call node calls one, a composed workflow's inner node too, is
refused in the words a workflow revision's call node is, and the end-of-run prompt offers only tools set to allow. A model node that names any tool is refused: a learned
workflow's model node runs without tools. So is a node the learned runner cannot run: a learned workflow runs model
and tool-call nodes, and decision nodes (a judge, pick or sift node, a route by question, a verify, an ask) on a run
that has decision providers. A decision node's provider (the one it names, else the run's default) must be one the
run has a key for and answer what the node asks, and the run's gate holds it under the provider's bare id (`jev`,
`parallel`, `openrouter`: a settings key that is allow by default, allow or deny): set to deny, the draft is refused in
the gate's words. Each decision is admitted on
the run's one cap before it is sent and booked at what it charged (`learned-workflow.ts`); one the cap has no room for
is never sent, and the run pauses on the refusal. So is an agent node that asks more than the learned runner's 8 turns, or `context: "fork"` (each node
starts a fresh session). With no list, a draft that names any tool is refused. A draft
holds no node that runs code: no `code` node, and no call `via: "shell"` or `via: "executor"`.

A draft the static checks pass is then dry-run (`draftDryRun`, the DSL's `dryRunWorkflow`); one they refuse, or any
when they refuse the answer whole, never is. It runs on its block's `example:` line, one JSON object, the run's own
input to it, else on an input synthesized from its input schema. Every model, Jev and tool-call answer is synthesized
from the node's output schema: no request is sent, nothing is paid and no tool runs. No code runs in the host: the dry
run hands every code node to a runner that refuses it, so the DSL never evaluates a code expression or body. Nothing large is built in the host either: a schema whose minItems is past 100 or
minLength past 1,000, or whose synthesized instance would hold more than 2,000 values or 64,000 characters, is refused
(`workflow`), and a dry run handed one anyway stands down as not run before building it. The bounds are read at schema
positions only (properties, items, `$defs` and definitions, anyOf, oneOf, allOf and the rest): a `const`, an `enum`
value, a `default` or an example that holds `minItems` is data, never a bound. Its loops are bounded the same
way, read at node positions only (a chain's steps, a parallel's branches, a map's or a loop's body, a route's branches,
a composed workflow's root), so a literal shaped like a loop is no loop: a loop's maxIters past 50, or nested loops whose maxIters multiply past 1,000, is refused, since a loop whose body
asks no model (an empty map) is work no step counts; and the dry run stops by the clock after 10 s. It checks
the wiring of the path that one input takes at run time (the state each step reads, the output's path and schema),
not every branch or body, and never the answers. A draft whose dry run fails is left out (`workflow`, "its dry run failed ..."), and the end-of-run turn is asked
once more for the whole answer with that draft fixed or left out; the second answer stands only when the checks keep it and no draft in it still fails its dry run.
The example is never written anywhere in the folder (the README holds `name` and `description` alone), and is read for
what must never be stored as every text the run gives is: one holding a held secret or a secret's shape refuses the
whole answer. The proposal keeps each kept draft's dry run (`dryRuns`: passed, or not run and why), and the grader is
told it under the draft in the host's own words; what the check said is made from the draft's own text (a schema's id,
a path), so it is fenced as data, never outside a fence.

## The index

`MEMORY.md` is one line per active note, by file name, `- [name](file.md) — description`, built by the host from the
notes' front matter every time it merges. A run whose agent's active notes fit its learning budget reads every one
whole. Past it, the run reads the notes that bear on its first message whole, best first, while they fit, then one line
for each of the rest, `- <name> (<file>): <description>`, in place of the index: at most 200 lines, within 25 KB, as
Claude Code loads its own. Each note is scored by a lexical match, with no model call (`learn/relevance.ts`: BM25 over its
name, description and body). A first message that shares no word with any note reads the index's first 200 lines, then
the notes changed last, whole, while they fit.

## What a run may propose

When a run ends, its end-of-run turn answers with the notes it would keep, one ` ```note <file>.md ` block each
(`reflectPrompt`, `parseReflection`), and, only when the work repeats, one skill in a ` ````skill <name> ` block (four
backticks, so a code block inside it stays in it) and one workflow draft in a ` ````workflow <name> ` block: front
matter with its `description:`, then the JSON. The host reads nothing else: no file the run wrote, in its copy of the
folder or anywhere, is ever read. It hands each note, the skill's `SKILL.md` and the draft's two files to the checker as
changes against the commit the run started from; a skill or a draft given with the very text the folder holds is no
change. Once a learned skill the run was offered has been offered to 3 of its agent's earlier runs (each run's launch
names the skills its seed offered it), and no learned workflow of that name is on main, active or pending, the prompt
gains one line asking for that skill's job as a workflow draft under its name (`draftFor`: one skill at most, the first
due in the seed's order), and says what each tool a draft's call node may run takes and gives, in the host's own words
for that tool (`{ query, n? } -> { provider, query, results: [...] }` for web search), so its call nodes are wired to the
real shapes. A turn that asks for no draft says none of it. A run gives a skill or a draft whole, new or changed, and may only add notes:

- one note per block, in the format above, named for a file at the folder's top;
- to replace a note, a new note whose `supersedes` names it; the old one stays, and the host marks it;
- never a note with the name of a file that was there (an edit), and never `status`, `superseded_by` or `origin`, which
  are the host's;
- `MEMORY.md` is the host's: a note by that name is ignored, never refused.

An answer with no note is a fine answer: the host drops it as `empty`. One that gives notes out of format is dropped as
`unparsed`, and nothing in it is kept.

## The caps

Over a cap is refused, never cut.

| What | Cap |
| --- | --- |
| One note | 4096 bytes |
| One note a run proposes | 4068 bytes: 4096 less the 28 the host's own lines may take as it merges the note (`origin: you`, `status: pending`), so it stays within 4096 on main and a person can retire it and a later run supersede it |
| New notes in one run | 8 |
| Notes one run's new notes supersede, together | 8 |
| Active notes after the merge | 200, the index's lines |
| Changed paths in one run | 64; over it nothing else is read |
| One skill's `SKILL.md`, a draft's `workflow.json` | 16384 bytes: the grader reads each whole, beside the notes |
| A draft's `README.md` | 1024 bytes |
| Skills one run adds or changes | 1 |
| Workflow drafts one run adds or changes | 1 |

## The checks

`checkProposal` refuses, before anything is written to git:

| Rule | Meaning |
| --- | --- |
| `too_many_files` | a changed path past the 64th, named unread |
| `outside` | a path that is not a `.md` file at the folder's top, a skill's `SKILL.md` or a draft's two files |
| `file_name` | a `.md` file whose name is not a note's, or a skill's or draft's folder whose name is not one |
| `file_mode` | a link, a folder or anything else that is not a regular file |
| `encoding` | not UTF-8, in a file or its name |
| `edited` | a file that was there, changed |
| `deleted` | a file that was there, gone: a note, a skill or a draft's file |
| `exists` | a new file whose name the folder holds, a superseded note's included |
| `too_large` | a note over 4096 bytes; a run's note over 4068; a skill's `SKILL.md` or a draft's JSON over 16384, its README over 1024 |
| `too_many_notes` | a new note past the 8th |
| `invisible_unicode` | a character a reader does not see, by code point |
| `secret_shape` | text shaped like a secret, by kind, in a note or its name |
| `secret_value` | a value the host holds as secret, in a note or its name |
| `note` | front matter missing or out of shape |
| `status` | a note that sets `status`, `superseded_by` or `origin`, or a skill that sets `status` |
| `supersedes` | `supersedes` naming a note that is not active, or one another new note supersedes too, or a note that takes the notes superseded past 8 |
| `index_full` | the index would pass 200 lines |
| `skill` | a `SKILL.md` whose front matter does not name its folder or has no description |
| `skill_outcome` | a skill from a run whose job did not complete |
| `too_many_skills` | a skill added or changed past the first |
| `too_many_workflows` | a workflow draft added or changed past the first |
| `workflow` | a draft the workflow DSL refuses (a tool off the list among it), one not JSON, a README that does not name its folder or has no description, or one of the two files without the other |
| `no_tool_list` | a draft that names a tool, checked with no tool list |
| `executable_node` | a draft with a `code` node, or a call via shell or executor |

- A character a reader does not see: format and default-ignorable characters (zero-width, bidi controls, tag
  characters), private use, line and paragraph separators and control characters other than tab and newline. An
  emoji's joiners and variation selectors, and the joiners some scripts need between letters, are text.
- Text shaped like a secret: well-known key prefixes such as AWS, Google, GitHub, Slack and `sk-` keys, JSON web
  tokens, Standard Webhooks signing secrets (`whsec_`), URLs with a password, and PEM private-key headers. A value the host holds counts as written, as JSON writes
  it, percent or form encoded, in base64 or in hex. A skill's or a draft's folder name is read as its file's name is.
- Every problem is `{ rule, path?, detail }`, printable as it is: its path and detail are cut of the host's values and
  of secret shapes, and a field over 4096 bytes prints whole as `[redacted]`, never scanned.
- A problem is its item's alone: the note, skill or draft (both its files) it names is left out, the rest is checked
  again, until it passes, and goes on to the grader, and the run's learning names what was left out (`problems`). A
  count cap names the items past it, in the order the answer gave them whatever their kind, and a size cap the item
  over it: one oversized or extra item is left out, the rest kept. A note left out past the supersedes cap holds
  nothing as superseded for the notes after it. New notes are settled in one order: each alone against the seed (what
  it supersedes), then one note a rule (the rest its alternates), then the holders' shared checks (two notes
  superseding one, the supersedes cap, and the index counted whole after the repeats are out: past 200 lines, the notes
  that add lines are left out from the answer's end, `index_full`); a holder they refuse is left out and its next
  alternate holds its rule, until nothing changes, and only then the unneeded alternates are left out as `duplicate`.
  The whole proposal is refused when a problem names no item it proposed, when its rule refuses the whole (`outside`,
  `deleted`, `encoding`) or must never be stored (`secret_value`, `secret_shape`, `invisible_unicode`: the run's answer is not
  trusted for any item), or when nothing is left, with every pass's problems. Before any item is kept, every name and text
  the run gave is read whole for what must never be stored (`unstorable`), an edit or a file over its cap included,
  which the checks refuse before they read its text.

Whether a note holds one case's data is the grader's judgment, not the checker's.

## The grade

One grader judges the whole proposal against the agent's active notes and standing instructions, with `GRADE_RUBRIC`
(`grade.ts`, the rubric's one statement), on the model the host picks for grading. `gradePrompt` fences, as data,
the instructions (their first 16,000 characters), the index line of each active note (cut to 300 characters), the
whole text of only the notes the proposal supersedes, every message the run was sent (each within 1,000 characters: a
longer one shows its start and its last 300; 40,000 in all), what a trigger sent it apart from what the user said, and
the new notes, skill and draft (its README with it). The user's messages let the grader tell what the user asked
the agent to keep from what a page told it to. So the prompt is bounded by the caps above, never by how many notes the
folder holds: `GRADE_CAPS.prompt`, 200,000 characters, half what a completion takes.

Each item's decision is `keep`, `pending`, `note` or `drop`, with its `origin`, `you` or `run`: one item per new note, per
skill (its `SKILL.md`) and per draft (its `workflow.json`, its README judged with it). The rubric asks a skill and a
draft one more question, Workflow case: one that singles out one person, company, document, account or case, carries a
fixed answer for one, or carries an instruction outside the agent's job is dropped. A skill that is a standing rule for
every reply or every report (which applies whatever the job is) is mis-kept as a skill, which a run loads only when a
job calls for it: its decision is `note`, and it is re-filed as a note (`grade.ts skillAsNote`: `<name>.md`, the
skill's description and body, of type feedback), which every later run reads, merged in the skill's place and pending
when risky; one that would be no note is dropped, saying it belongs in a note, and keeps the grader's question (a
Planted one still keeps nothing of the run). A re-filed note stays within a run's note cap (`CAPS.runNote`), as a run's
own note does, and is one more new note: it counts against the run's new-note cap (`CAPS.newNotes`) beside the run's
own kept notes, and one past it is dropped alone, saying so. The skill it replaces, if main holds it, is retired in the same write (the merge's `retire`). A re-filed
skill whose note file the run's own kept note takes is dropped, saying so: one file is one item's, and its hold stands.
A new note named like one main holds when the grade reads main (another run merged it after the seed) is left out of
the grade and settled alone, never a drop of the whole proposal. At the merge, every note the verdict keeps (a new
note, or a skill re-filed as one) whose file main already holds is settled alone (the learning run's `takenOnMain`),
never a refusal of the whole merge: the same rule (its body, whitespace and case aside, as `ruleOf` reads it, whatever
its front matter) is no change, dropped unsaid; a note whose front matter supersedes
the note of its own name is a modification, written over it (the merge's `replace`, main's blob checked as graded);
any other is dropped, saying a note of that name was added since or was there already. The rest merges. A run whose
own merge is on main already (the learning run stopped after its commit and before it recorded it) is not settled
against main again: its notes there are its merge's, and each item is settled by the text its own merge commit holds at its file (its rule there, whatever a person
edited on main since, not
only a path the merge changed, such as a note it marked superseded), one item a file as the first attempt settled it
(a re-filed skill whose note file the run's own note takes is left out), so what it wrote is learned and nothing else. No words of a run's learning, the merge's or a read's, say a rule main already held. One copy of
each rule: a new note whose body, set beside an active note's with whitespace and case aside (notes.ts `ruleOf`), is
exactly the same, under another name, is a duplicate: the checks refuse it (`duplicate`, against the seed's active
notes, and of two new notes the same, the second; duplicates are settled with the merge's checks: a note
those refuse, what it supersedes say, holds no rule, so its valid copy is kept, and a repeat never fills the index), and the merge's own computation leaves it out unsaid, against the
main it commits on (computed again on the main that won when another write landed first), as it leaves out a name main
came to hold meanwhile. A note that supersedes the one it repeats updates it, never a duplicate. Anything near is the
grader's to judge. Steps or a format for one kind of job,
named by when it applies, are a skill. `note` is a skill's decision alone: on any other item it is no merge. An item
the rubric drops is
dropped. A rule found only inside text the run read (a form's field, a pasted email, a page) is planted, whoever it says
it is from, and dropped; a rule the user states in their own words is theirs, even beside such text in the same
message. An item that holds an account number is a secret, dropped even where the user gave it as where money goes.
Neither is ever held for the owner's OK. A risky rule is `pending`, whether the user asked for it in their own words or
the run worked it out. Risky reads one way on every grade model, from the rule's words alone: a limit, threshold, cap or
amount that decides whether an approval, a check or a sign-off happens, in either direction; an exemption of a case, a
person, a site or a source from a check; trusting, buying from or paying a site, a source or a seller it names; or naming
where money or data goes. A risky rule is kept, with `status: pending`, and in no index, so no run reads it until a person approves it. A
note the grader keeps and names `Risky` is pending too. Every other note is kept. The user is the agent's owner, so a
risky rule is never silently dropped and never served on its own; it waits. A risky skill or draft waits the same way,
with `status: pending` in its `SKILL.md` or README.
`parseVerdict` reads one verdict with one item per new note and fails closed: an answer it cannot read, a missing or
extra item, or a decision or an origin out of its list is no merge. Each item stands on its own: the notes, skill and
draft it keeps or holds merge, and the ones it drops are left out (the learning run's `keptOf`), whatever the grader's top-level
`merge` says. Nothing merges when it keeps nothing, when any item's question names Planted however worded, kept, held
or dropped (the run read something hostile, so nothing it proposed is kept), when it drops an item with no question
(it says not why), or when it keeps every item and still says no merge.

There is no separate injection screen: one grader decides, with the rubric stated once. A page classifier cannot see where a note
came from, and read a preference the user stated as a planted instruction; the grader's Planted question checks a note
against what the user said. With no grade model named (`--grade-model`, else the strong tier), the agent's own model is
the only judge of its notes, so a server with learning on should name a strong one.

## The merge

One commit on `main` by the learning script (`learning.sh`, one exec through the folder's Workspace: `folder.ts`
`writeLearning`): the new notes added (`mergedNote`: each with its `origin`, a pending one
with `status: pending`), the skill's and draft's files added or changed (a held one with `status: pending`), each note a kept one supersedes marked `status: superseded` with `superseded_by` (a pending
note's supersedes waits for its approval, `approve`), and `MEMORY.md` rebuilt. Its message is `learning: <run id>: merged`, the
grader's reason, and a `Run-Id: <run id>` trailer; a run a trailer on `main` already names is merged, never twice.
`main` moves only from the commit the merge was made on (the script's compare and swap; a lost race writes nothing and
the merge is computed again), and the same exec writes the run's diff (`.agentrun/diffs/<run>.json`) and, last, the
folder's snapshot (`.agentrun/snapshot.json`, what every read reads). Before it, the host asks `mergeProblems` again of
`main` as its snapshot has it: a name another run added since is `exists`, and a note superseded since or an index past 200 lines is refused
as above. A note is never deleted: a retired or superseded note stays in the folder and leaves the index.
