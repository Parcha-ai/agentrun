---
packages: @parcha/agentrun-import
kind: feature
---
`atOf(counts, i)` takes anything that holds Counts' numbers (`Pick<Counts, "values">`), not only a whole `Counts`. Existing calls work as before. `parseHome` now keeps each request's numbers in that same stride and reads each request's time with `atOf`, so a totals read's numbers are copied once rather than request by request. Its totals and what its `requests` sink is handed are unchanged.
