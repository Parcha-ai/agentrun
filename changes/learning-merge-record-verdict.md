---
packages: @parcha/agentrun-serve
kind: breaking
---
A learning run's merge record keeps each item's final decision (kept, held for the owner's OK, or left out, with its words), and a run's learning end (`GET /v2/runs/{id}/learning`, the run view) reads its notes, skills and workflow drafts from it alone, so a note the merge left out is never listed as learned or waiting. A merge recorded before this upgrade has no such record, so its learning end lists none of them: no `verdict`, `learned`, `pending`, `skills` or `workflows`.
Upgrading: nothing to do; a run that merged before the upgrade reads as merged, with no item decisions and no `skills` or `workflows` listed.
