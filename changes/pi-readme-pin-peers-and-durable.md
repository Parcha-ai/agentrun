---
packages: @parcha/agentrun-pi
kind: docs
---
The README pins every peer install line to `@1.3.0` (typebox to `1.3.7`) and says that Pi 1.4 is not supported yet: an unpinned install now resolves Pi 1.4.0, and an unpinned pi-durable or chord fails with `ERESOLVE` against the peer range. It no longer says a run "is not checkpoint resume" next to the paragraph that says an interrupted run continues, and it has a new section on running a workflow as a durable pi-durable task (`createWorkflowTool`, `createWorkflowExtension`): what a resume answers from the journal and what it refuses.
