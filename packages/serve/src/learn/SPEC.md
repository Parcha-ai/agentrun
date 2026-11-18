# An agent's learning folder: the contract

An agent's learning is a folder kept by its host: its owner's standing corrections, one file, and the workflows its
runs compiled. Every run reads the corrections whole in its instructions, under `# Learned`, and its learned workflows
as tools. This page is the contract: the folder, the corrections, the workflow draft a compile turn gives, the checks,
the caps and the commit. The code is the server's own, beside this page: `corrections.ts` (the corrections file),
`check.ts` (the checks), `workflow-draft.ts` (a draft's files and dry run), `compile.ts` (the compile turn's prompt and
the parser of its answer), `promote.ts` (the promotion record) and `commit.ts` (the writes). None of it runs git or
calls a model: the rest of the server does both.

The risk it is built against: an agent reads untrusted pages, and what it learns reaches every later run without a
person. So nothing a run worked out is served as words: a correction is its owner's own words, and a run's own
learning is a workflow, checked in code and then replayed against the agent's own answers before it serves.

## The folder

```
corrections.md                    the owner's standing corrections, one per line, served whole under # Learned
workflows/find-policies/          a workflow draft: its workflow.json and its README.md, together
audits.jsonl                      the audit ledger: a started line and a row per audit of a served run, host-written
```

The folder is plain git with one branch, `main`; git is its history and its undo. The host is its only writer: no run
writes it, and nothing in it runs.

## Corrections

`corrections.md` is a markdown list, one correction a line, in its owner's words (`correctionLine`: `- ` and the words,
whitespace folded to single spaces). A run is served the file whole under `# Learned`, after one line saying what it
is (`Your owner's standing corrections from earlier runs, one per line. Follow each one that applies.`). Nothing
picks, ranks or summarizes it: the cap keeps it whole.

- An owner's feedback on a run (a grade's words, or a message they sent after the job's first) appends one line, at
  the run's end, in the same commit as anything the run compiled (`LearningChange.correction`). The run is a feedback
  round, `correction`.
- A person replaces the file whole over v2 (`PUT /v2/agents/{id}/learning/corrections`, under the ETag its GET
  gave); an empty body empties it.
- Over `CORRECTIONS_CAP`, 2048 bytes, a write is refused whole, never cut, and the run's learning says why. So is one
  holding what must never be stored (below).

## A workflow draft

A workflow draft is `workflows/<name>/workflow.json` and `workflows/<name>/README.md`, both or neither; its name is 1
to 64 lowercase letters, digits, dashes and underscores, starting with a letter or digit. The host writes the README
from the one-line description the draft's block gives (`draftFiles`): front matter with the folder's `name` and that
`description`, and `status: pending` when a step calls a tool with no price (it waits for its owner's OK). A turn adds
or changes at most one draft. The workflow DSL's own `validateWorkflow` judges the draft, with no code run
(`executeCode: false`) and the agent's tools as the list a node may name: the tools its definition grants that a
workflow's call node runs on this server, so a harness's own tool (`Bash`, `exec_command`, `apply_patch`) is never on
it, nor is a tool the gate does not allow (set to ask or deny, under the server's tool settings and the agent's own): a
draft whose call node calls one, a composed workflow's inner node too, is refused in the words a workflow revision's
call node is, and the compile prompt offers only tools set to allow. A model node that names any tool is refused: a
learned workflow's model node runs without tools. So is a node the learned runner cannot run: a learned workflow runs
model and tool-call nodes, and decision nodes (a judge, pick or sift node, a route by question, a verify, an ask) on a
run that has decision providers. A decision node's provider (the one it names, else the run's default) must be one the
run has a key for and answer what the node asks, and the run's gate holds it under the provider's bare id (`jev`,
`parallel`, `openrouter`: a settings key that is allow by default, allow or deny): set to deny, the draft is refused in
the gate's words. Each decision is admitted on the run's one cap before it is sent and booked at what it charged
(`learned-workflow.ts`); one the cap has no room for is never sent, and the run pauses on the refusal. So is an agent
node that asks more than the learned runner's 8 turns, or `context: "fork"` (each node starts a fresh session). With no
list, a draft that names any tool is refused. A draft holds no node that runs code: no `code` node, and no call
`via: "shell"` or `via: "executor"`.

A draft the static checks pass is then dry-run (`draftDryRun`, the DSL's `dryRunWorkflow`); one they refuse never is.
It runs on its block's `example:` line, one JSON object, the run's own input to it, else on an input synthesized from
its input schema. Every model, Jev and tool-call answer is synthesized from the node's output schema: no request is
sent, nothing is paid and no tool runs. No code runs in the host: the dry run hands every code node to a runner that
refuses it, so the DSL never evaluates a code expression or body. Nothing large is built in the host either: a schema
whose minItems is past 100 or minLength past 1,000, or whose synthesized instance would hold more than 2,000 values or
64,000 characters, is refused (`workflow`), and a dry run handed one anyway stands down as not run before building it.
The bounds are read at schema positions only (properties, items, `$defs` and definitions, anyOf, oneOf, allOf and the
rest): a `const`, an `enum` value, a `default` or an example that holds `minItems` is data, never a bound. Its loops are
bounded the same way, read at node positions only (a chain's steps, a parallel's branches, a map's or a loop's body, a
route's branches, a composed workflow's root), so a literal shaped like a loop is no loop: a loop's maxIters past 50, or
nested loops whose maxIters multiply past 1,000, is refused, since a loop whose body asks no model (an empty map) is
work no step counts; and the dry run stops by the clock after 10 s. It checks the wiring of the path that one input
takes at run time (the state each step reads, the output's path and schema), not every branch or body, and never the
answers. The example is never written anywhere in the folder (the README holds `name` and `description` alone), and is
read for what must never be stored as every text the turn gives is: one holding a held secret or a secret's shape
refuses the whole answer.

## Compile once

The compile turn is one more turn of a run's session at its end. It asks for the first workflow once the agent has its
definition's `learning.compile_after` completed runs of its own (20 by default; a run its learned workflow answered
alone and a check's replay run are not counted), and for a revision of one only when its promotion record holds it,
once per hold. A hand-back, a stop by the money rule and a wrong grade of a served run ask for none: each is one
sample, and the hold reads it among the workflow's others. The turn reads the agent's last runs (each run's input, tool
calls, answer and what the person said after it), the workflow language as the DSL renders it (`authorContract`, with
this host's addendum) and one worked example the checks pass. An SDK task carries no owner feedback, so its runs learn
through the compile turn alone.

Its answer is one ` ````workflow <name> ` block (four backticks, so a code block inside it stays in it): front matter
with its `description:` and `example:`, then the JSON. The host reads nothing else: no file the run wrote, in its copy
of the folder or anywhere, is ever read. The draft's files go to the checks as changes against the commit the run
started from (a revision's against the commit its text was read at). What they refuse goes back to the model, as data,
and the turn answers again, up to `COMPILE_RETRIES` (3) times. A draft that passes is committed to main directly
(`commitDirect`): nothing grades it, and its promotion check (below) decides whether it serves.

A job compiles once: a turn whose drafts all fail their checks is the compile's attempt all the same, kept as a
promotion record (a hold with nothing checked, `n` 0, its reason starting "its draft failed its checks" and naming
them). A first compile's earns the one recompile, as a check's hold does; a recompile's stops (`check.stopped`).

## Promote once

A new revision is checked once before it serves (`runner/promotion.ts` startCheck, settleCheck). The first run that
lays it replays it on the inputs of the agent's last `compile_after` completed runs it fits (one replay run each, at
workflow cost, one check at a time), and the agent takes the runs meanwhile. Each input is scored against the agent's
own recorded answer to it (`sameAnswer`): no grade and no teacher is read. The two answers are compared on the fields
that say the decision, as the definition declares them in `learning.agree_on` (`learning-setting.ts` agreeOnOf): dotted
paths into the answer's JSON object (`verdict.decision`, `["mcc", "riskTier"]`), each segment an object's own key; each
path must resolve in both answers' values (bare JSON, a whole fence, or the last fenced json block) to equal values, and
a path that resolves in neither or in only one (a key missing, a segment through an array, text or null) disagrees.
Without it, the whole answer is compared, equal as JSON or as trimmed text, and a hold that answered some inputs alone
and agreed on none says "its answers never matched the agent's word for word; name the fields that carry the decision
(learning.agree_on)". No field is read off the `output_schema`: its enum can be an echo of the owner's setting (kyb's
`risk_appetite`) while the decision sits deeper (`verdict.decision`), and a default that promotes on the wrong field is
worse than one that never promotes. A shipped template whose answer carries a decision declares it (kyb, inbound-lead),
each path a required property of its output schema at every level (`templates.ts` readPackage refuses one an answer may
leave out); one whose answer is generated text (market-monitor, release-notes) compares the whole answer. The record
keeps `check.agree_on` when it compared paths, and its reason says "said what the agent said on mcc and riskTier".
No grader turn decides it: one would cost a model call on every check row and add a model's variance to a gate, where a
declared rule is free and exact. Of the inputs it ran on, `alone` is the share
it answered with no escalate and no failed step (a replay obeys an escalate, so an input one of them hands back is no
answer alone), and `agreement` the share of those that say what the agent said. A newer revision that comes while a
check runs waits and records nothing; the claim after the running check is decided starts the newest. It is promoted
when agreement is at least `learning.agree_min` (0.8) and alone at least `learning.alone_min` (0.7). Under either bar
it is held, and the agent's next run it fits asks one revision with the inputs it did not agree on as data (each one's
input, the agent's answer, and the draft's answer or why it handed it back); that revision is checked the same way.
Held again, it stops (`check.stopped`): the agent keeps the runs and nothing compiles again until a hold or its owner
acts. The record keeps `check`: the bar it was held to, `n`, `agreed`, `alone`, the runs it read, the tools that stopped
skipped inputs (`skipped_tools`) and, on a hold, the disagreements. A promotion by check is never moved by grades. The
inputs are the agent's last `compile_after` runs of its own picked first, however many runs its workflow served since.
Every reserved input counts in `n`: one whose replay run was never created, or never ended, by the check's deadline is a
failed input, never left out, in `n` and in `outcomes` alike (the record's `unstarted` counts the never created; every
one: its replay's read is `failed`). A draft with nothing to check it on (none of those runs has an input it takes, or every
input was skipped at a write, such as an MCP tool listed with no `readOnlyHint`) is never promoted: it stops
(`check.stopped`, `n` 0) with a reason starting "nothing to check it on", which the loop read shows as the compile's
draft error, and it asks no recompile (a revision would have nothing to be checked on either).

The shadow audit: a run a promoted revision serves first is audited at 1 in `learning.audit_every` (10), and at 1 in
`learning.audit_every_later` (20) once that revision has served `learning.audit_later_after` (50) runs. The draw is
sha256 of the run's id, so a claim taken again draws the same (`learn/audit.ts` auditDrawn). The served count it reads
pages past the shadows and the agent's own runs (`learn/compile.ts` lastRunsOf), never a fixed window of newest runs.
Only a run started over the API is drawn: one a trigger started (its checkout, the thread it answers on) is never
audited, counted `not_auditable` on the promotions read. And only an agent every tool of which only reads, by the rule a
check's replay skips writes by (`auditWriterOf`: an MCP tool by its pinned `readOnlyHint`, a built-in by READ_TOOLS, the
computer's tools among them): an agent that can call a write is never audited, and the promotions read says why
(`audits_off`, "audits off: <tool> can write"), since a shadow would do that write a second time. A drawn run, at its
end (`runner/audit.ts` withAudit, before the end commits, the workflow read from its journal), first appends a started
line to `audits.jsonl` (`{source: "started", run, shadow_run, workflow, digest, promoted_at, turn, at}`, `turn` the id
of the run's newest answer row then: the answer audited), then starts its shadow run (startAudit). A capped run's shadow is capped at what the served run's cap left: its cap now, less what it
spent under it (`runner/learning-end.ts` auditRoomOf), so the two never spend past the
served run's cap; the served run's later gates count the shadow beside it (shadowBesideOf: its cost once it ended, its cap
until then). With less than a run's smallest cap left (`RUN_CAP_MIN_USD`, $0.01) or a spend not known, no shadow is
started: the row `{..., shadow_run: null, agreed: null, skipped: "no allowance"}` is written instead. A shadow never
waits on a person: where it would park (an approval its tool settings ask, a raise of its cap, a question) it ends failed
at once in AUDIT_PARKED's words, the ask its park wrote withdrawn in that end's commit, its cost booked
(`AdapterRunSpec.neverWaits`, the adapter loop's parkClaim; the gate is not bypassed: nothing it asks about runs, and no
one is asked). A shadow ended once its cost passed its cap (the kernel's overCapEnd) is one too. Its row is
`parked: true` with `agreed` null: neither agreed nor disagreed, never counted toward the hold. The shadow is the same agent and revision on the
same input with learning off (no seed, no end-of-run turn), its id `audit.<run id>`, its launch's `audit`
naming the run it audits; a shadow whose line could not be written is never created. The shadow is no row of the run
list, sends no webhook, is no run of the stats, GET /runs/{id} reads it with `audit_of` and `path` `audit`, and its cost
is the served run's learning (its `cost.learning_usd` and its learning cost in the cost series; `cost.usd` stays the
served run's own spend). While the shadow is queued or running the served run's all-in is unknown, never $0
(`store-reads/learning.ts` shadowSpendOf): its `cost.learning_usd`, `cost.all_in_usd` and learning cost read null until
the shadow ends. Each claim of a run that learns first settles the open audits (started lines with no row yet), reading
each one's two runs by id, never a window of newest runs: once both ended it writes the row `{run, shadow_run, workflow,
digest, promoted_at, source: "shadow", agreed, served_cost, shadow_cost, turn, at}`, `agreed` by `sameAnswer` of the
shadow's answer and the served run's answer row `turn`, compared on the served run's revision's fields as its check
compares (its `learning.agree_on`, else whole), read from the run by that id (null when either answer is
missing or a run is gone, never counted): a follow-up's answer since is never the one compared, for the verdict or a
hold's disagreement. An owner's grade of a run the workflow answered alone is a row too (`source: "grade"`, `agreed` the
grade, `turn` the answer graded). `promoted_at` names the promotion the line counts for: the `at` of the
promote record that began the digest's newest run of promote records (`learn/promote.ts` promotionStartOf) when the
shadow started or the grade was given. The host alone appends to the ledger, one commit a write with a `host:` subject
and no trailer (no change a person or a run made), and keeps its newest 2,000 rows with their started lines and every
open one, each claim's batch oldest served run first. GET .../learning/audits reads the rows. The hold is a function of
the ledger: every such claim applies the rule again over the rows as they are, rows added or not, so a hold a crash lost
after its rows were committed is made at the next claim. The hold rule (`applyHold`) reads the newest
`learning.hold_window` (10) rows with a verdict of the serving revision's current promotion (so a revision its owner's
replay promotes again after a hold starts on none): `learning.hold_disagree` (3) disagreements or more hold it (a hold
record carrying `audit`, keeping the bar, the rows read and each disagreement's served run, shadow run, input, the
agent's answer and the workflow's, each text cut of the host's secrets whole before it is shortened to 1,200 characters,
`learn/secrets.ts` excerptShown, as a check's are). The agent takes the runs, and its next run it fits asks one recompile with those
disagreements as data; S3a's check decides it on its usual inputs plus the disagreeing ones. A second audit hold within
`learning.stop_window` (100) served runs of the first stops it instead (`audit.stopped`, reason "stopped: the workflow
disagreed with the agent twice"): no compile is asked. The graded hold is gone: a grade is one more row. The money rule
still stops a workflow that costs more than the agent by hand.

## The caps

Over a cap is refused, never cut.

| What | Cap |
| --- | --- |
| `corrections.md` | 2048 bytes |
| A draft's `workflow.json` | 16384 bytes |
| A draft's `README.md` | 1024 bytes |
| Workflow drafts one turn adds or changes | 1 |

## The checks

`checkDraft` refuses, before anything is written to git:

| Rule | Meaning |
| --- | --- |
| `outside` | a path that is not one of a draft's two files |
| `file_name` | a draft's folder whose name is not a workflow's |
| `file_mode` | a link, a folder or anything else that is not a regular file |
| `encoding` | not UTF-8, in a file or its name |
| `deleted` | a draft's file that was there, gone |
| `too_large` | a draft's JSON over 16384 bytes, its README over 1024, or `corrections.md` past 2048 |
| `invisible_unicode` | a character a reader does not see, by code point |
| `secret_shape` | text shaped like a secret, by kind, in a file or its name |
| `secret_value` | a value the host holds as secret, in a file or its name |
| `front_matter` | a README that sets more than `name` and `description` |
| `kept` | a workflow a person retired, or one waiting for its owner's OK: a run never changes it |
| `workflow` | a draft the workflow DSL refuses (a tool off the list among it), one not JSON, one whose dry run failed, one whose answering step (the model node writing the key `output.path` reads) names tier `fast`, one whose model step off the fast tier reads a page it fetched (compact state, below), one whose answer carries quotes of pages it fetched with no code quote check (below), or a README that does not name its folder or has no description (a draft is always both files: one answer gives them) |
| `no_tool_list` | a draft that names a tool, checked with no tool list |
| `executable_node` | a draft with a `code` node, or a call via shell or executor |

- A character a reader does not see: format and default-ignorable characters (zero-width, bidi controls, tag
  characters), private use, line and paragraph separators and control characters other than tab and newline. An
  emoji's joiners and variation selectors, and the joiners some scripts need between letters, are text.
- Text shaped like a secret: well-known key prefixes such as AWS, Google, GitHub, Slack and `sk-` keys, JSON web
  tokens, Standard Webhooks signing secrets (`whsec_`), URLs with a password, and PEM private-key headers. A value the
  host holds counts as written, as JSON writes it, percent or form encoded, in base64 or in hex. A draft's folder name
  is read as its file's name is. Before anything is kept, every name and text the turn gave is read whole for what must
  never be stored (`unstorable`), a file over its cap included; corrections are read the same way
  (`correctionsProblems`).
- Compact state. A model step off the fast tier (an agent, decide, extract or report step with no `"tier": "fast"`,
  the answering step among them) never reads a page a call step fetched: a draft is refused when such a step's
  `state` map reads a key that may hold a page, or, with no `state` map, when the whole state it reads holds one. A
  string's placeholders are the ones interpolation fills (the DSL's `placeholdersOf`: a marked `{x?}` only as the
  whole string, literal text inside a longer one), each resolved by the DSL's own lookup (`placeholderValue`, which
  interpolation reads through: the path as written, so a real `state` key first, then the path after `state.`) over a
  state holding only the pages, each with every path. A page is a call's `as`; a map's collected result when its
  body's is one (a map over pages sees `item` as one; its `failedAs` rows are short errors, never pages); a pick's or
  sift's over pages; a composed workflow's answer when its own is one, its child seeing a page through an input that
  reads one. Steps are read in run order: a model step writing a page's key ends it; a parallel's branches start from
  the same state and their writes merge, so a key one branch replaced is no page after it; a route runs one branch, so
  a key stays a page unless every branch replaced it; a loop's body is read pass after pass, each on every page its
  passes may leave, until the marks stop changing, within its `maxIters`. Pages reach the agent's model only through a
  fast-tier step's output, the compiled job's cascade: on chain14b the drafts fed whole pages to the answering step
  (4.1 requests a run at ~70k cached tokens each, $0.364 a served run), where the research shape (a fast extract's
  compact facts to the answer) booked ~$0.08. Decision nodes go to a decision provider, not a tier, and are not read;
  nor is a draft for the SDK bridge, whose `runNode` picks every model itself. One line a step, in words the compile
  retry acts on. The dry run gets no byte budget: it runs on placeholder values its schemas synthesize, never a run's
  pages, so its state's size says nothing of a served run's.
- The quote check is code. A draft whose output schema has a `quote` or `quotes` property (its `#/definitions` refs
  read as the DSL reads them, its own inline definitions before the catalog; items and `anyOf`/`oneOf`/`allOf` read)
  and which fetches pages (a call step, under any chain, branch or body) must check each place in its answer holding
  quotes with an escalate whose `when` is the DSL's `quote_missing` reading them: its `path` and `field` the list and
  the field the schema puts them at. A quote key's schema is read shape by shape (each `anyOf`/`oneOf` branch, each
  kind a `type` list names; `allOf` members are one value, read together), each shape a place of its own, so
  `quotes: string | [{quote}]` needs a check reading `quotes` and one reading `quotes` with `field` `quote`. Quotes no
  one `path` and `field` read (under two lists, in a map, in records with no `quote` key) are refused whatever checks
  run, as `quote_missing` would read none of them. The escalate is a step of the top-level chain after the last step
  writing the answer's key, the one path every run takes: a check in one route branch, or before the answer is
  written, misses the answer of another run. Each of its `pages` must be a key holding a page as fetched: a call's
  `as`, a map's whose item result (its `resultPath`, else its body's `as`; never its whole item state, which carries
  the state around it) is a call's, a composed workflow's whose answer is a call's result, and no step writing that
  key writes anything else. A model's summary of a page is no page, nor is the key a model step writes it back to. A
  composed workflow node writing the whole answer whose own workflow passes this rule in its own state has checked the
  places its own schema declares; any other place the parent's schema declares is the parent's to check. An answer
  schema holding quotes in more than 8 places, nesting past 16 keys, or recurring around them (a definition used again
  inside itself), is refused rather than read in part. Otherwise the draft is refused, the detail naming the predicate
  to write. The predicate reads each page string alone, so no quote runs from one page into the next. A judge or an
  `ask` asked whether the quotes are verbatim is never the check: on H5, Jev's question flagged 149 of 170 answers
  while 416 of 429 quotes were in the fetched pages, and it could not tell the 8 answers (4.7%) quoting text no page
  held from the rest. The predicate compares lowercased text with curly quotes straight, dashes as `-` and whitespace
  runs as one space, then letters and digits alone; quotes under 8 characters are not checked; its
  `escalate.evaluated` event says how many quotes it checked and missed, never their text. It reads the answer a model
  step wrote, never a judge's field.
  Once the checks hold, the answer re-picks once before one hands back: the top-level step writing the answer is a
  `loop` with `maxIters` 2 whose `until` is `not` of the check's `quote_missing` (the same `path`, `field` and
  `pages`), its body the step that answers, which reads the compact facts and its failed draft through its `state`
  map, the draft as the DSL's optional placeholder `"draft": "{answer?}"`: null on the first pass, before any draft
  exists, and the failed draft on the second. The DSL sends a step with a map only the keys it names, each pass a
  fresh model session, so a map without the draft never sees it; naming it unmarked (`"{answer}"`) fails the first
  pass; and a step with no map reads the whole state, the pages included (compact state, above). The draft is exactly
  the whole marked answer key, `"{answer?}"`: no path is validated, so none below the key (`"{answer.x?}"`, which the
  answer may not hold) or under `state.` (`"{state.answer?}"`, which reads a real `state` key first) counts. A draft
  whose model step writing the answer in the loop does not read it so is refused. A quote found first costs no
  re-pick; a second miss hands back. Otherwise the draft is refused, the detail naming the loop to write. The check is
  a step of the top-level chain after the loop, never inside it: a `quote_missing` escalate anywhere in the loop's body
  (a composed workflow's included) hands back on the first draft's miss, so the loop never re-picks, and a draft with
  one there is refused. A loop exit is kept in the call's journal entry even when no node ended. A loop's `until` is
  one predicate and none joins two, so the answer's quotes have one check: a draft whose quotes need two different
  checks (`quotes: string | [{quote}]`, or quotes in two places) is refused, since a loop watching one would let the
  other hand back with no re-pick; the detail asks for one place one check reads. On H5d (preregistered, 259 dead-site
  merchants) the check fired on 31; the answer step once more over the run's pages kept 26, right 76.9% against the
  drafts' 50.0%, at 11.6% of the agent's cost where handing every miss back (H5c) cost 21.7%. Each loop exit is a row
  of the run's metrics (`loops`: `{node, iterations, met, workflow}`), so a re-pick (`iterations` 2) and whether it
  found its quotes (`met`) are counted; its request is booked as any node's.
- Every problem is `{ rule, path?, detail }`, printable as it is: its path and detail are cut of the host's values and
  of secret shapes, and a field over 4096 bytes prints whole as `[redacted]`, never scanned.

## The commit

One commit on `main` per round by the learning script (`learning.sh`, one exec through the folder's Workspace:
`folder.ts` `writeLearning`): the passing draft's files added or changed (a held one with `status: pending`) and the
owner's correction appended to `corrections.md`. Its message is `learning: <run id>: merged`, the reason, and a
`Run-Id: <run id>` trailer. A round merges once: the script creates `refs/agentrun/runs/<run>` (`<run>.r<n>` for a
later round) in the same ref transaction as `main`'s compare and swap, so a second merge of it, however it raced the
first (a reclaimed run's two claims), writes nothing and reads the first's. A draft file that is not on
main as it was on the run's seed (or the commit a revision read it at) is a conflict, never written over. `main` moves
only from the commit the change was made on (the script's compare and swap; a lost race writes nothing and the change
is computed again), and the same exec writes the run's diff (`.agentrun/diffs/<run>.json`) and, last, the folder's
snapshot (`.agentrun/snapshot.json`, what every read reads). A stop between the merge and its diff leaves the run's
ref with no diff: the next read of the round's merge (the end step's, or a second merge's) writes it from the ref. A person's replace of `corrections.md` is one commit the
same way, under the ETag they read. A workflow is never deleted by a run: a retired one stays in the folder and
serves no run.
