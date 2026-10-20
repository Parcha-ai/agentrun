---
name: workflows
description: How to write a workflow that makes later runs cheaper, check its work inside it, and use what it returns. Read it before you write, fix or run one.
---

# Write one node per step

A workflow pays off when each step is the cheapest node that can do it. From cheapest:
- `call` with `"via": "tool"`: one tool call, no model. Its `args` come from the input or an earlier step; its `out` is
  the tool's own result shape (describe lists each tool's arguments and result).
- `extract`, `pick`, `judge`, `route`: one decision over what a call returned, one model or judge request each.
  `extract` copies facts from text into a schema, `pick` chooses one item of a list, `judge` answers yes-or-no
  questions, `route` runs one of several branches (a route by `valuePath` asks nothing).
- `agent`: a model session that calls tools as it goes, so it costs more with every call. Use one only for a single
  step that needs open-ended looking around, with `tools` limited to that step and a `budget_usd`. Never the whole job.

Each node writes its result at its `as`, and later nodes read it by path: `"{page.text}"` in `args` or `state`,
`page.text` in `requires` and in predicates.

An optional input field: never interpolate it where it may be absent. Inspection refuses a `{field}` the input lacks,
and inside a `route` branch, where inspection does not look, the run fails on it. Either require the field in the input
schema and run the workflow only on inputs that have it, or start with an `extract` that has no `state` map (it reads
the whole input) and returns fields every input gets, such as `"given": "yes"` or `"no"` and the value or null, then
branch with a `route` whose `valuePath` names `given`, and read the value from the extract's output.

Stop with an `escalate` (`"kind": "needs_input"`) when a required value is missing or a call found nothing:
`"when": {"predicate": "empty", "path": "page.text"}`. Test text, not a yes-or-no field of a call or extract: a dry run
fills their text with placeholders and their yes-or-no fields with false, so a stop on false fires in every dry run.

# Check inside the workflow

Put the check where the doubt is: a `judge` that sees the source text beside the value taken from it, then an
`escalate` when the text does not support the value, before the output. Checking by hand after a run repeats it.

# Use what it returns

- `complete`: its output is the answer. Answer from it; reading again what it read repeats the job.
- `escalated`: do by hand only the step it stopped at; its summary says which.
- `failed`, or a complete result that proves wrong: fix the workflow, not each run. Load it, change the step, inspect
  it with this input, dry-run it, and save it under the same name.

# Example: take one field from a page

```json
{ "v": 2, "name": "page-field",
  "schemas": {
    "Input": { "type": "object", "properties": { "url": { "type": "string", "minLength": 1 }, "field": { "type": "string", "minLength": 1 } }, "required": ["url", "field"], "additionalProperties": false },
    "Page": { "type": "object", "properties": { "url": { "type": "string" }, "text": { "type": "string" } }, "required": ["url", "text"] },
    "Found": { "type": "object", "properties": { "value": { "type": ["string", "null"] }, "quote": { "type": ["string", "null"] } }, "required": ["value", "quote"], "additionalProperties": false },
    "Check": { "type": "object", "properties": { "supported": { "type": "boolean", "description": "Does the page text state this value for the field, as the quote says?" } }, "required": ["supported"], "additionalProperties": false }
  },
  "input": { "schemaId": "Input" }, "output": { "schemaId": "Found", "path": "found" },
  "root": { "node": "chain", "steps": [
    { "node": "call", "label": "read-page", "via": "tool", "tool": "fetch_page", "args": { "url": "{url}" }, "out": "Page", "as": "page", "deadline_s": 30 },
    { "node": "escalate", "label": "no-text", "when": { "predicate": "empty", "path": "page.text" }, "kind": "needs_input", "stage": "read", "summary": "{page.url} has no readable text." },
    { "node": "extract", "label": "take-field", "instructions": "Copy the value of the named field from the text, and the sentence that states it. Null for both when the text does not state it.", "state": { "field": "{field}", "text": "{page.text}" }, "tools": [], "out": "Found", "as": "found" },
    { "node": "escalate", "label": "not-stated", "when": { "predicate": "empty", "path": "found.value" }, "kind": "needs_input", "stage": "extract", "summary": "The page does not state {field}." },
    { "node": "judge", "label": "check-field", "state": { "field": "{field}", "value": "{found.value}", "quote": "{found.quote}", "text": "{page.text}" }, "out": "Check", "as": "check" },
    { "node": "escalate", "label": "unsupported", "when": { "predicate": "field_equals", "path": "check.supported", "value": false }, "kind": "needs_input", "stage": "check", "summary": "The page does not support that value for {field}." }
  ] } }
```
