---
packages: @parcha/agentrun-serve
kind: fix
---
The model picker's free mark (`harnesses[].free_models` in `GET /capabilities`) now uses the kernel's free-model rule, the same one that decides what a run books at $0, so the two cannot disagree. A catalog price tier that leaves out its input or output price is no longer read as $0.
