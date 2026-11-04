---
packages: repo
kind: feature
---
The console shows what a run has cost so far when its whole cost is unknown. The run header, the runs list, an agent's runs, Mission Control's latest runs and the live runs under Needs you read "so far $0.0123 · 1 not priced", from the server's `so_far_usd` and `unpriced`, in place of "Unknown". It says "est." for a local estimate, and the run header's hover says it is not the whole cost. "Unknown" stays for a run whose server says neither. The console's reads of a cost bound, which no server sends, are removed: `at_most_usd`, `/v2/stats`' `bounded_unknown`, and the "≤ $x" and "up to $y more for N cut runs" lines.
