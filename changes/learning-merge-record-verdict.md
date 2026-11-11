---
packages: @parcha/agentrun-serve
kind: breaking
---
A learning run's merge record keeps each item's final decision (kept, held for the owner's OK, or left out, with its words), and a run's learning end (`GET /v2/runs/{id}/learning`, the run view) reads it, so a note the merge left out is never listed as learned or waiting.
Upgrading: nothing to do. A merge recorded before this upgrade has no such record: its learning end reads no item decisions (no `verdict`, `learned` or `pending`).
