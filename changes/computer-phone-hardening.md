---
packages: @parcha/agentrun-computer
kind: fix
---
phone-harness, from the third read of #2000:

- The vendor's unlock reply is redacted of every occurrence of the unlock code, not only the first.
- A connect and the last holder's release no longer race the phone's adb transport. A connect waits for a disconnect still on its way, and takes its hold before `host:connect`, so a last release meanwhile keeps the transport.
- Every adb the provider spawns runs with no `ADB_*`, `ANDROID_ADB_*` or `ANDROID_SERIAL` variable in its environment, so nothing in the host's environment (`ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_SOCKET`, …) points the CLI at another server than its socket requests reach.
- The conformance module's file ledger judges its lock by its holder, not its age. The lock names the writer's pid and is linked into place whole. A live writer's lock is never taken, however old: a write waits up to `waitMs` (10 s), then fails in words. A crashed writer's lock is broken at once, by one waiter at a time, so two writers never run together. Before, a lock was taken once it was 30 s old, from a live writer too, while a writer gave up after 10 s.
