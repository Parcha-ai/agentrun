---
packages: @parcha/agentrun-serve
kind: fix
---
A secret's hex identifier is found however it is written: a sign-in pointer (`ctx/<uuid>`, `agentrun-<hex>`) or any value that is mostly a run of 16 or more hex digits is matched and cut uppercased, with its dashes dropped or moved, or with underscores, colons or dots for them. A learned note that wrote a pointer that way passed the learning end's refusal, was merged, and was served uncut by the run view and given to later runs; it is now refused, and the run view cuts it in place. A shorter hex run, a run that is only a key's tail, and a value with none (a key in mixed case), is still matched only as written. Upgrading: nothing to do.
