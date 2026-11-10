---
packages: @parcha/agentrun-serve
kind: feature
---
The server runs workflows on its own code: the durable workflow task, its node runner, decisions and their recovery, and the runner a learned workflow's model nodes use moved into the server from `@parcha/agentrun-pi`, which the server no longer depends on or loads. It depends on `@earendil-works/pi-agent-core` 1.5.0 directly, beside `@earendil-works/pi-coding-agent` 1.5.0. Workflow runs, their decisions and their costs behave as before.
