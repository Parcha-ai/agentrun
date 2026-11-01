---
packages: @parcha/agentrun-serve
kind: ci
---
**serve's box archive test writes a later box's record only once the start sweep has marked the old one**
- The test wrote the later record right after a `GET /runs`, which is answered while the start sweep still settles. A sweep still inside its reap of the old record then wrote that record's reaped mark over the new one, so the archive found a record already let go and reaped nothing.
- It now waits for the sweep's mark on disk before writing the later record, as a run process would (no run starts before the sweep is done), and checks that the record the archive marks is the later box's own.
