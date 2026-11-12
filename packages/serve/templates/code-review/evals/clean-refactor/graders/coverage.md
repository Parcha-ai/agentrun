---
type: llm
---
Pass only if the answer's `coverage` has one entry for `src/format.ts` and one for `src/invoice.ts`, each with a verdict that names what was checked (for example that the rename keeps the same arithmetic, or that the one caller uses the new name), not a bare "looks correct". Fail otherwise.
