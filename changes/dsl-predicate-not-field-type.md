---
packages: @parcha/agentrun-dsl
kind: feature
---
Two mechanical predicates for `loop.until`, `escalate.when` and `poll`. `field_type` {path, type} holds when the value at `path` is of a JSON type (`number`, `string`, `boolean`, `array`, `object` or `null`); a number only when finite, and an absent value is of no type. `not` {of} holds when `of` does not, and takes only a mechanical predicate, so a judged `ask` never sits inside a negation. Together they let a guard fail closed on a value that is present but of the wrong type: `escalate` with `{"predicate": "not", "of": {"predicate": "field_type", "path": "score", "type": "number"}}` fires on `"abc"`, `null`, NaN or an object, where `gte` and `lt` on `"abc"` never fire. Validation names a bad `type` or a judged `of` by its path (`when.of`). `FIELD_TYPES` lists the types; the author contract, the workflow schema and the Lean model carry both predicates.
