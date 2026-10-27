---
packages: @parcha/agentrun-adapters
kind: feature
---
`@parcha/agentrun-adapters/kernel` and `@parcha/agentrun-adapters/process`: the durable kernel a harness adapter runs on, over the run's session store, and the shared layer for harnesses that run as a child process.
- An effect is its intent, then at most one outcome, each durable before what follows: a completed or failed effect is answered from its records and never runs again. When a drive opens, an intent a dead process left open is run again if its tool is `safe`, and recorded failed and interrupted if it is `never` ("it may or may not have taken effect"), never run again.
- Input is placed before it is sent, and a withdraw that lands first wins. A large native record is kept as a blob in the session's own records.
- `./process` has the native journal, the transcript fold, the recovery note, the tool bridge, the hook-pair calls of a harness's built-ins and the inbox. These are copied from another project and listed, with each file's upstream blob and sha256, in `vendor/durable-harness/UPSTREAM.json`; `NOTICE` credits it.
