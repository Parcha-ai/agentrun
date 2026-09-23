# Workflow format

AgentRun documents are JSON data: `v: 2`, `name`, `schemas`, optional `input: {schemaId}`, `output: {schemaId, path}`, and `root`. Schema identifiers refer to the document's own catalog. Define the input and expected output before adding nodes. The [language reference](language.md) is the complete contract: every node kind, field and predicate the validator admits. The installed `@parcha/agentrun-dsl/schema` is the editor schema; execution performs additional semantic checks. This guide shows the patterns.

## Minimal typed answer

The complete [inline typed example](../SKILL.md#minimal-typed-example) shows the minimal extraction pattern and its input. The model must extract the stated facts; the example itself is not a passed quality test.

Important fields:

- `requires` names paths in workflow state, not renamed keys in the prompt map. It is a **nonempty-evidence guard**, not a field-existence check: missing/null values, blank strings, empty arrays and objects without concrete values fail before model construction. `false` and `0` are concrete values. If an empty search result is valid input to a recovery step, handle it explicitly rather than declaring it nonempty.
- LLM `instructions` are literal prose. They do not substitute `{text}`.
- `state: {text: "{text}"}` explicitly chooses the JSON user message. Omitted `state` sends accumulated state, excluding legacy reference catalogs.
- `out` names the node's schema; `as` stores its value in state. For agent/extract/decide nodes, omitting `as` stores under the node's `label`; fields are not merged into top-level state. `output.path` selects the final value to validate.

For repository work, an agent can declare `tools: ["read", "grep"]` only if those tools are available. Read the host's tool argument schemas; do not invent parameters. Use `tools: []` for a tool-free agent or extraction. Omitting the list inherits the runner's allowed tools; it does not mean tool-free execution.

## One direct tool operation

Read [read-file.json](../examples/read-file.json) and its [input](../examples/read-file.input.json). This performs one active built-in `read` call; it needs no model or Jev system one decision. Replace the input path with the file the user asked to read.

A host tool returns the host's own result envelope. The example's `read` built-in (from the Pi host) returns `content`, an array of text/image blocks, and optional `details`. Give `call.out` a schema for that tool return, rather than the final answer or a plain string. A later extraction can transform it into a different output schema. The bundled fictional `search` tool is the exception: its direct effect result is `{sources}`. A `call` needs its host tool name, typed `args`, result `out`, state key `as`, and positive `deadline_s`.

## Composition and decisions

Read the complete [release-note review](../examples/review-release-notes.json) and its [input](../examples/review-release-notes.input.json) before composing nodes. It maps a typed extraction over two notes, collects only each `change`, then summarizes the collected changes. This needs an agent adapter, but no Jev or external tools.

Use `chain.steps` for dependencies. Each `parallel.branches` entry receives the same input; branches must write different top-level keys. In `map`, `itemsPath` selects the list and the body sees `item` and `item_index`; set `as` and bound `maxConcurrency`. A body with `as` already returns that value per item. Use `resultPath` to select a different path, or to avoid retaining whole parent states from a chain body without `as`. A `loop` needs `until` and integer `maxIters` from 1 through 20; reaching the bound is not proof of success.

A Jev `judge` has a nonempty `state` map, `out`, and `as`. Its schema is flat: descriptions state questions, booleans yield yes-probabilities, enums yield choices, and integers with 2 to 10 explicit level descriptions in `criteria` yield scores. Scores range from 0 to the last level index. Raw answers are retained at `<as>$answers`; confidence is not calibrated accuracy. `sift` applies questions to each item, and `route` chooses a branch. Use an explicit uncertainty gate or escalation rather than inventing evidence. Supply the complete reviewed rubric; Jev question text is not a substitute for an unavailable SOP.

For `sift`, add a flat question schema to `schemas`, then a node such as:

```json
{
  "node": "sift", "label": "select-migration-notes",
  "itemsPath": "notes", "out": "MigrationQuestions", "as": "selected",
  "keep": { "path": "actionable", "gte": 0.8 }
}
```

`MigrationQuestions` can declare `actionable` as `{"type":"boolean","description":"Does this release note state a concrete change a client maintainer must make, rather than only announce a feature?"}` inside its object `properties`. Set `required: ["actionable"]`. Read selected originals from `selected.items`, retained decisions from `selected.values`, and evidence sidecars from `selected.answers`. The `gte` value gates the yes-probability; it is an example threshold to review, not a calibrated guarantee. Handle empty results explicitly with an `escalate` node using `when: {predicate: "empty", path: "selected.items"}` before synthesis.

A `sift` batches all full items into one Jev request; `state` adds shared context
and `describe` adds summaries, neither replaces the items. The assembled request
must fit the selected provider's token context and any explicit host byte guard;
the adapter does not impose a default byte ceiling. A local `jev_state_too_large`
report names the node, measured bytes and configured host limit; it means no HTTP
request was sent. For independent judgments over larger originals,
use an explicit `map` with a `judge` body and selected original-text/provenance
fields, preserving the full rubric and necessary headers/qualifiers. See the
[Jev guide](jev-decisions.md); no automatic splitting or truncation occurs.

### Check the edges before running

For each connection, name the actual value produced and the exact path consumed.
These are different contracts; do not make them all the final answer schema:

Inspection displays typed state keys and the final selection. It rejects nested
paths excluded by known closed producer schemas before execution. Dynamic code,
open schemas, unions and conditional control flow may leave shapes unknown;
passing inspection does not prove those paths exist at runtime.

| Producer | Value available downstream |
| --- | --- |
| Host tool called with `as: "read"` | `read.content` and optional `read.details`; not the fields inside `details` at top level |
| Agent/extract with `out: "Row", as: "row"` | The schema-valid Row at `row`, not `{row: Row}` inside it |
| Code with `as: "total"` returning a number | The number at `total`; returning `{total: number}` adds a second wrapper |
| Map with an agent body using `as: "row"` | An array of Row values; no `row` wrapper on each item |
| Map with a chain body and `resultPath: "row"` | An array of Row values selected from each completed body state |

Without `resultPath`, a chain map body retains the whole item state. That is not
the same as collecting its last step. After mapping, an array is still an array:
if the final contract is an object, explicitly assemble that object and point
`output.path` to it. Preserve the same distinction for tool result schemas and
final answer schemas. Inspection does not execute transforms or prove these
runtime shapes; check the reported value and contract when execution fails.

An `escalate` node always requires `when`. Inside a route branch, the branch-taken predicate below makes escalation unconditional for that branch; outside a branch, provide a predicate for the actual stopping condition.

A `route` needs a nonempty `state` map and at least two named branch objects with `body` nodes. This fragment uses the release review's `changes` state and `Report` schema:

```json
{
  "node": "route", "label": "check-migration-detail", "as": "routing",
  "state": { "changes": "{changes}" },
  "instructions": "Can a maintainer follow every supplied migration action without guessing missing details?",
  "branches": {
    "ready": {
      "criteria": "Every action specifies the concrete client change needed.",
      "body": {
        "node": "extract", "label": "summarize-ready-changes",
        "instructions": "Summarize the supplied migration actions and return changes unchanged.",
        "state": { "changes": "{changes}" }, "out": "Report", "as": "report"
      }
    },
    "needs_details": {
      "criteria": "Any action lacks a required detail or the supplied changes conflict.",
      "body": {
        "node": "escalate", "label": "request-migration-details",
        "when": { "predicate": "field_equals", "path": "routing.taken", "value": "needs_details" },
        "kind": "needs_input", "stage": "migration", "summary": "Migration details need clarification."
      }
    }
  },
  "unsure": { "branch": "needs_details", "gte": 0.8 }
}
```

`unsure` selects the conservative branch below its confidence gate. Preserve the raw decision evidence; reaching `ready` does not prove migration correctness.

Mechanical checks belong in predicates; semantic questions belong in agent/Jev nodes. Code is trusted JavaScript, not a sandbox, and runs only when the host authorizes it (the addendum names how). Do not turn an unavailable tool or missing verifier into generated code that bypasses the host.

## Code transforms and schema references

Read the complete fictional [evidence gate](../examples/evidence-gate.json) and its [input](../examples/evidence-gate.input.json). It preserves a supplied claim and evidence, asks one Jev question, and gates the raw yes-probability in code before returning a typed record. It uses no agent or tool; running it with a real judge still needs Jev. The repository test uses a fake judge and proves interface behavior, not semantic quality.

A code node permits **only** `node`, `label`, `code`, and optional `as`. Its `code` is a single synchronous function expression, such as `(s) => ({ count: s.items.length })`, not a bare statement body. The function receives the **full accumulated workflow state** as its first argument; it does not receive a scoped prompt map. Do not add `state`, `requires`, `out`, or `instructions` to a code node.

Tool-host inspection uses nonexecuting syntax/mechanical validation, equivalent to SDK `validateWorkflow(workflow, {executeCode: false})`. It neither evaluates code factories nor probes their outputs. The ordinary SDK validation default is for trusted code and may execute factories/probes. Neither mode is a sandbox or a proof that the eventual result will satisfy the output schema.

Use synchronous data operations such as `Math`, `JSON`, `Array`, `Object`, `Map`, and `Set`. The current executor shadows `Date`, `Promise`, timers, host/network globals, and `Function`; they are unavailable even in a trusted run. For example, derive calendar-month sequences from integer year/month pairs rather than `new Date(...)`. This catches accidental host dependencies; it is not an isolation or security boundary.

- With `as: "result"`, the returned value is stored at `state.result`; do not also wrap it in `{result: ...}`.
- Without `as`, return an object patch: its top-level fields shallow-merge into state. Other state keys remain; returning a nested object replaces that entire top-level value. A non-object or array return is stored under the node's label instead, so use an object for patch semantics.
- Do not mutate the input state. Return new values; do not return a Promise. Code remains trusted host JavaScript, not a sandbox.

A node's `out: "Record"` names a sibling catalog schema directly. Inside a schema, the same sibling is referenced as `{"$ref":"#/definitions/Record"}`, **not** `{"$ref":"Record"}`. The example's input and result schemas both use this form. A `judge` has no `instructions` field: put each complete question in its output schema property's `description` (and its decision criteria in `criteria`, when needed).

### Gate the raw probability, not the decoded boolean

For a judge with `as: "check"` and boolean question `supported`, read:

```js
(s) => {
  const p = s['check$answers']?.answers?.supported?.noul;
  return {
    accepted: typeof p === 'number' && Number.isFinite(p) && p >= 0.90 && p <= 1
  };
}
```

With `as: "gate"`, this stores `gate.accepted`. Missing, malformed, nonfinite, or out-of-range probabilities fail closed. Follow it with an `escalate` whose `when` is `{predicate: "field_equals", path: "gate.accepted", value: false}`, as in the example. The threshold is illustrative policy, not a calibrated accuracy guarantee.

`check.supported` is only the decoded boolean (yes at probability 0.5); it does **not** prove a 0.90 threshold. Likewise, `route.unsure.gte` gates the route's **own new choice confidence**, not an upstream judge's yes-probability. Giving a route the earlier boolean or asking it to enforce a number is not this deterministic gate.
