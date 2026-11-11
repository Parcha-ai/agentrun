---
packages: @parcha/agentrun-serve
kind: breaking
---
A browser session's open record is now flushed to disk before its vendor is asked to create the session. Until now, on the runner, the record was committed but not yet on disk when the vendor started billing: the runner's flush before a tool call comes before the call opens its session. A box lost in that window left a billed session that no record named, so the next claim could not release it. Who breaks: a program that binds an entry of the exported `TOOLS` table with a run ledger must now pass the ledger's `flush` (the store flush that runs before the vendor is asked) beside `paid` and `pause`.
