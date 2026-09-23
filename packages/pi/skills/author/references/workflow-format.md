# Workflow format

The grammar, node kinds, edges and node-type discipline are the shared [author contract](dsl-contract.md), the same text every AgentRun host's author reads. This file is the Pi host's addendum: its tools, its tool result envelopes, its examples and its `agentrun` extension.

AgentRun documents are JSON data: `v: 2`, `name`, `schemas`, optional `input: {schemaId}`, `output: {schemaId, path}`, and `root`. Schema identifiers refer to the document's own catalog. Define the input and expected output before adding nodes. The installed `@parcha/agentrun-dsl/schema` is the complete editor schema; execution performs additional semantic checks.

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

A built-in returns a Pi tool result: `content` is an array of text/image blocks and `details` is optional. Give `call.out` a schema for that tool return, rather than the final answer or a plain string. A later extraction can transform it into a different output schema. The bundled fictional `search` tool is the exception: its direct effect result is `{sources}`. A `call` needs its host tool name, typed `args`, result `out`, state key `as`, and positive `deadline_s`.

## Composition and decisions

Read the complete [release-note review](../examples/review-release-notes.json) and its [input](../examples/review-release-notes.input.json) before composing nodes. It maps a typed extraction over two notes, collects only each `change`, then summarizes the collected changes. This needs Pi, but no Jev or external tools.

The structure nodes (`chain`, `parallel`, `map`, `loop`) and the question nodes (`judge`, `sift`, `pick`, `route`) are defined in the shared contract. In Pi, a question node runs only when TypeSafe access is configured; use an explicit uncertainty gate or escalation rather than inventing evidence, and supply the complete reviewed rubric, since Jev question text is not a substitute for an unavailable SOP.

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

The producer-to-consumer contracts (tool `call` result at `as`, LLM value at `as` without a wrapper,
code `as` versus patch, map arrays and `resultPath`) are the shared contract's edges section. What is
Pi's: inspection displays typed state keys and the final selection and rejects nested paths excluded by
known closed producer schemas before execution; dynamic code, open schemas, unions and conditional
control flow may leave shapes unknown, so passing inspection does not prove those paths exist at
runtime, and inspection does not execute transforms. Check the reported value and contract when
execution fails.

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

Mechanical checks belong in predicates; semantic questions belong in agent/Jev nodes. Code is trusted JavaScript, not a sandbox, and requires the user's trusted run in the extension. Do not turn an unavailable tool or missing verifier into generated code that bypasses the host.

## Code transforms and schema references

Read the complete fictional [evidence gate](../examples/evidence-gate.json) and its [input](../examples/evidence-gate.input.json). It preserves a supplied claim and evidence, asks one Jev question, and gates the raw yes-probability in code before returning a typed record. It uses no agent or tool; running it with a real judge still needs Jev. The repository test uses a fake judge and proves interface behavior, not semantic quality.

Native inspection uses nonexecuting syntax/mechanical validation, equivalent to SDK `validateWorkflow(workflow, {executeCode: false})`. It neither evaluates code factories nor probes their outputs. The ordinary SDK validation default is for trusted code and may execute factories/probes. Neither mode is a sandbox or a proof that the eventual result will satisfy the output schema.

Use synchronous data operations such as `Math`, `JSON`, `Array`, `Object`, `Map`, and `Set`. The current executor shadows `Date`, `Promise`, timers, host/network globals, and `Function`; they are unavailable even in a trusted run. For example, derive calendar-month sequences from integer year/month pairs rather than `new Date(...)`. This catches accidental host dependencies; it is not an isolation or security boundary.

The code node's fields, its `as` versus patch semantics and the `$ref` form are the shared contract's; in Pi, code remains trusted host JavaScript, not a sandbox, and runs only under the user's trusted run.

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
