---
packages: @parcha/pi-transport
kind: feature
---
The record stream (`./home`): a host that passes `connectHome`'s `records` (a `RecordSink`) keeps the session's log.
The runner puts each commit in an outbox beside its store before the store has it, ships its writes and its
recorder's lines (`runMain(app, { recording })`) once it has, sends what the host lacks on every connect, starts no
effect the host's log lacks (`admitsTool`, `admits`), seals only what the host holds (`not_shipped`), and keys each
model request by its generation (`key`, `position`). `registerMoveConformance` takes `records: true`.
