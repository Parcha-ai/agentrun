---
packages: @parcha/agentrun-dsl
kind: fix
---
**A map's `resultPath` now selects the item result through `getPath`, the one reader `requires`, interpolation, `itemsPath`, `output.path` and predicates all use, so a `resultPath` names the same value every other reader would.**
- A map selected the item result with its own `split(".").reduce`, so a `resultPath` like `res.list.length` picked an array's `length` property (a number) where `getPath` — and therefore `requires` and `output.path` reading the same shape — resolves undefined. A `resultPath` that names an array property, a string index, or a non-canonical array index now yields a missing result (`missing_map_result`) instead of a value no other reader would produce. A `resultPath` that names a record key or a canonical array index is unchanged. No `resultPath` in the repo's examples, fixtures or Lean conformance workflows, nor in the learned-workflow stores or C3's classify-company revisions, changes verdict.
- The recovery driver's map-length bookkeeping reads `itemsPath` through `getPath` for the same consistency; it is behavior-neutral — the driver only uses the result as `Array.isArray(list) ? list.length : 0`, and the two readers differ only on a non-array result, which that guard maps to `0` either way.
