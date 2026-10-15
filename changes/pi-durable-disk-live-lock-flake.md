---
packages: @parcha/pi-durable-disk
kind: fix
---
The live suites' runner (`test/live/ci.ts all`) no longer exits 13 instead of 1 when another live run holds the lock: its
lock holder stays referenced until the lock is decided, so a refused holder whose pipes close before its exit event no
longer leaves the process with nothing to wait on and its top-level await unsettled.
