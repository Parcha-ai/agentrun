---
packages: @parcha/agentrun-harness, @parcha/agentrun-pi
kind: feature
---
The cost fold (`cost`, which `--max-usd` and a demo's spend cap read) and the recording validator read `agentrun.decisions` in both of its forms: the single document (a `receipts` list) and the keyed documents (one row each, `key` its place). A keyed row counts once, however often a snapshot lists it, and a row with no cost makes the cost unknown, never 0.
- `durableDecisions(file)` (`@parcha/agentrun-pi/durable`) reads a store file's decision rows in commit order in either form; `durableDoc(file, "agentrun.decisions").receipts` is nothing in the keyed form.
- A recording that holds both forms is refused by the validator: one form per recording.
- This lands before the writer that makes the keyed form, so no run spends past its cap on a store the fold cannot read.
