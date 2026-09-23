<!-- Generated from packages/dsl/authoring/contract.md by scripts/generate-author-references.mjs. Edit the source, not this copy. -->

# AgentRun author contract

You author AgentRun DSL v2 workflows as JSON data. A workflow is a document the interpreter runs; it is
never prose, never a filename, never code that calls the engine. This contract is the grammar and the
discipline every host shares. A host adds its own addendum: which tools exist, what the initial state
holds, how a workflow is delivered and reviewed, what its output types are. Where this contract and a
host addendum disagree, the host addendum wins on host matters and this contract wins on grammar.

## The ruling rule: minimal first, complexity earned

The best workflow is the fewest nodes that do the task reliably. Judgment lives in LLM and question
nodes; a decision read from meaning costs a fraction of a cent and adapts where code silently breaks.
Add a code gate, an extra escalation, a mechanical derivation only when observed behavior earned it,
and say what earned it in the node's label. A first draft that anticipates failure classes nobody has
seen is the wrong draft.

## The document

`{"v": 2, "name", "schemas": {id: JSON Schema, ...}, "input"?: {"schemaId"}, "output": {"schemaId", "path"?}, "root": node}`

- `schemas` is the document's own catalog of inline JSON Schema objects. Every `out`, `input.schemaId`
  and `output.schemaId` names an id in it. Inside a schema, a sibling is referenced as
  `{"$ref": "#/definitions/Name"}`, never as `{"$ref": "Name"}`.
- `input.schemaId`, when declared, is validated against the input before the root runs; an input that
  fails it is rejected as `input_invalid`. Without it, the host's initial state is the input.
- `output.path` selects the final state value; `output.schemaId` validates it. Without a path, the
  whole state (minus reserved host keys) is the output.
- Execution has one shared state object. Every node returns a patch: with `as`, the node's value is
  stored at that key; without `as`, a code node's object return shallow-merges into state, and an
  `agent`, `decide` or `extract` without `as` stores under its label. A `report` always writes
  `report_markdown`, whatever its label. Nothing else about state is implicit.

## Node kinds and their fields

A field marked `*` is required. `state` on an LLM or question node is a mapping of the keys that node
receives; `"{path}"` placeholders resolve against state and a whole-placeholder value keeps its type.
Instructions are literal prose: they are never interpolated. Refer to state keys in plain words and
declare what must be present in `requires`.

Structure:

- `chain` — `steps*`: nodes in order; each sees the state the previous one left.
- `parallel` — `label*`, `branches*`: every branch receives the same input state and runs at once; each
  branch's patch merges back in branch order; branches must write disjoint keys (validated).
- `map` — `label*`, `itemsPath*`, `body*`, `as*`, `resultPath`, `maxConcurrency`: fan out over a state list;
  the body sees `item` and `item_index` added to state; results collect at `as`. A body with `as` yields
  that value per item; `resultPath` selects a path from each finished body state; without either, a chain
  body keeps the whole item state.
- `loop` — `label*`, `body*`, `until*`, `maxIters*` (1..20): bounded repetition. Reaching the bound is not
  success; the state passes through as is and a following node judges the unmet condition.
- `workflow` — `label*`, `workflow*`, `input*`, `out*`, `as*`: run a complete child document as one step.
  The child declares `input.schemaId` and `output`; its state and schema catalog are isolated; the parent
  owns terminal delivery. A child never lives inside a map or loop body in hosts with cursor recovery.
- `route` — `label*`, `state*`, `instructions*`, `branches*` ({name: {criteria, body}}), `unsure`
  ({branch, gte}), `as`, `requires`: a question chooses one named branch; `unsure` sends the choice to a
  conservative branch below a confidence gate; the decision is retained at `as` (`<as>.taken`).

Model nodes (each runs an agent with the instructions, the SOP slice the host supplies for `sopSection`,
and the state it receives):

- `agent` — `label*`, `instructions*`, `out*`, `as`, `state`, `sopSection`, `requires`, `tools`, `effort`,
  `thinking`, `tier`, `verify`: gathers new evidence with the tools it is given and submits a value of `out`.
- `decide` — same fields: judges what is already in state; its tools verify, never expand scope.
- `extract` — same fields: transcribes facts already stated in the state, verbatim, null when absent.
- `report` — `label*`, `instructions*`, `state`, `sopSection`, `requires`, `tools`, `effort`, `thinking`:
  the terminal prose writer; it renders the typed record already in state and never invents one. Its
  output is always `state.report_markdown` (it takes no `as`); at most one, never inside a map body.
- `artifact` — `label*`, `type*`, `path`, `instructions`, `state`, `sopSection`, `requires`, `tools`,
  `effort`, `thinking`: the terminal deliverable of a host output type; at most one, last in the root.
- `verify` (a clause on agent, decide, extract) — `out*`, `state`, `maxDrives`, `override: {below}`: a
  typed question reviews the submission before it is accepted. `out` names a flat question schema with
  at least one boolean question (the acceptance); a rejected submission is driven again up to
  `maxDrives`; exhaustion is a failure, never a silent acceptance.

Question nodes (one typed request to the host's judge; no prose, no tools):

- `judge` — `label*`, `state*`, `out*`, `as*`, `requires`: `out` is a flat schema whose property
  descriptions are the questions; booleans yield yes-probabilities, enums yield a choice (with per-option
  `criteria`), integers with 2..10 described levels in `criteria` yield a score. Decoded values land at
  `as`; raw answers with probabilities and confidence at `<as>$answers`.
- `pick` — `label*`, `itemsPath*`, `describe*`, `instructions*`, `as*`, `state`, `allowNone`, `requires`:
  choose one item from a list; `allowNone` when no item may fit.
- `sift` — `label*`, `itemsPath*`, `out*`, `as*`, `describe`, `state`, `keep: {path, gte}`, `requires`:
  ask the same questions of every item in one request; `keep` retains items whose yes-probability at
  `path` is at least `gte`; read `<as>.items`, `<as>.values`, `<as>.answers`.

Mechanics:

- `code` — `label*`, `code*`, `as`: one pure synchronous function of the full state,
  `(s) => value`. No `Date`, `Math.random`, timers, network, `require`, or mutation of `s`. Only
  `node`, `label`, `code` and `as` are permitted on it.
- `call` — `label*`, `via*` (`tool` | `executor` | `shell`), `as*`, `deadline_s*`, plus `tool`, `args`,
  `code`, `input`, `command`, `env`, `where`, `out`, `produces`, `retry`, `poll`, `requires`: one effect
  the host performs; `out` describes the effect's actual return, not the final answer; effects are
  idempotent by key and never retried blindly across an uncertain outcome.
- `escalate` — `label*`, `when*`, `kind*`, `stage*`, `summary*`: when the predicate holds, stop and surface
  the case; `summary` interpolates `{dot.paths}` from state. Reserve it for conditions a reviewer must
  unblock; an outcome the output schema can express is a record, not an escalation.

Predicates (`when`, `until`, and the `keep` and `unsure` gates read the same way):

- `field_equals` `{path, value}`, `field_true` `{path}`, `in` `{path, values}`, `empty` `{path}`
- `count_gte` `{path, n}`, `gte` `{path, n}`, `lt` `{path, n}`, `no_new_items` `{key}`
- `ask` `{instructions, state, criteria, gte}`: a typed yes/no question to the judge, gated at `gte`

Name in every mechanical predicate a path the initial state or an earlier node writes: on a missing
value, `empty` is true and the others are false, so a predicate on a path nothing writes is a
decorative guard (or an always-on one) that reads as a real condition. Validation catches some of these
(interpolated paths and code outputs it can probe, when the host declares the input keys); it does not
prove every stopping condition names real state. That is the author's job, and the reviewer's.

## Edges: name the value produced and the path consumed

Every connection is a contract between one producer's value and one consumer's path. Check each before
running: a tool `call` with `as: "read"` yields the tool's return at `read`, not its fields at the top
level; an LLM node with `out: "Row", as: "row"` yields the Row at `row`, not `{row: Row}`; a code node
with `as: "total"` yields the number at `total`, and returning `{total}` adds a second wrapper; a map
yields an array at `as`, and an object contract needs an explicit assembly step with `output.path` on
it. `requires` is a non-empty-evidence guard on state paths (null, blank, empty array or object fail;
`false` and `0` pass), not a rename of prompt keys.

## Node-type discipline

- Prose in, structure out is an LLM node, never code. A regex over prose (a question, page text)
  returns empty on the next phrasing and nothing notices; a payload the host embedded as data is the
  exception, and code may parse it.
- Transcription versus judgment: `extract` transcribes what the state already states; `decide` judges;
  `agent` gathers. Use the cheapest kind that reads the meaning.
- Code is for typed-state mechanics only: membership against parsed rows, threshold gates, carry-forward,
  arithmetic, joins. Its inputs are fields other nodes produced or the host seeded.
- Questions (`judge`, `sift`, `pick`, `route`, `ask`, `verify`) are focused semantic decisions over
  complete evidence. Give a question the original material, not another node's opinion about it; ask one
  coherent judgment per property; put the whole question in the description. Gate on the raw
  probability in code when a threshold other than 0.5 matters; a decoded boolean is the 0.5 reading.
- The report node writes the report. A judgment node's schema never carries a prose field the report
  should render; the record is typed, the rendering is the report's.
- Every SOP-bound node's `sopSection` is the exact heading text after `## ` in the host's SOP.
  A wrong value fails the run, and a host with no SOP runs no `sopSection` nodes.

## Delivery

Deliver the document as data through the host's submit channel, complete and self-standing: every
schema inline, every referenced id present, every tool named exactly as the host names it. Never invent
a tool, a capability, an evidence source or a passed check. Validation and the dry run are the host's
gates and they run the same on your draft and on your submission; check before you submit. A valid
document is a candidate; activating it is the host's decision.
