---
type: llm
---
Pass only if (a) exactly one finding is reported, at `src/usage.ts` line 5 (the `return row.spentUsd ?? 0;` line; a range 4-5 passes), with `priority` `P0`, saying a row whose `spentUsd` is null (unknown) now reads as 0, so a capped run keeps admitting work, citing `CODEREVIEW.md:4` or the doc comment; (b) no finding says rows with only `legacyCostCents` lose their cost, or asks to keep the legacy reader (the repo's `CODEREVIEW.md:7` says never to flag that); (c) if `dropped` lists that legacy-reader candidate, its reason is `never-flag`; and (d) the answer's `risk_score` is 5 (4 passes). Fail otherwise.
