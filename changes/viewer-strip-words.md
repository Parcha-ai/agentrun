---
packages: repo
kind: fix
---
The run viewer's counter strip reads as words a stranger takes for what they are (`apps/viewer`). A count with more that may have happened is a range from the proven count to every possible one, `0–1`, where it read `0 + 1 possible` (looks paid, repeated, re-asks). A count the recording cannot give reads `not recorded`, where it read `not measured`. A cost with a part nobody priced reads `not priced`, where it read `unknown`. The calls admitted and never completed are `calls in doubt`, with those still running as `1 (3 running)`, where the counter was labelled `unknown`. Neither is ever shown as 0 or $0, as before. The transport panel's rows, the vision panel's meters and the workflow map's ledger use the same words, from `NOT_RECORDED`, `NOT_PRICED` and `rangeLabel` in `./counters.ts`. The strip's items come from `stripItems(counters, ...)` in `./app.ts`, so a test can read them without a page. The counters and RECORDING.md section 6 do not change.
