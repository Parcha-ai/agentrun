---
packages: @parcha/agentrun-computer
kind: fix
---
phone-harness, from the third read of #2000:

- The vendor's unlock reply is redacted of every occurrence of the unlock code, not only the first.
- A connect and the last holder's release no longer race the phone's adb transport. A connect waits for a disconnect still on its way, and takes its hold before `host:connect`, so a last release meanwhile keeps the transport.
- `adbCli(path, { env })` spawns adb from the environment it is given, with every `ADB_*`, `ANDROID_ADB_*` and `ANDROID_SERIAL` variable dropped, so nothing in it (`ADB_SERVER_SOCKET`, `ANDROID_ADB_SERVER_SOCKET`, …) points the CLI at another server than its socket requests reach. The library reads no environment itself. The conformance module passes its own, without its `COMPUTER_PHONE_HARNESS_*` names, so the API key never reaches adb, whether the adb's path comes from its setting or from its `adb` option. A transport given as the option is used as it is.
- The conformance module's file ledger judges its lock by its holder, not its age. The lock names the writer's pid and is linked into place whole. A live writer's lock is never taken, however old: a write waits up to `waitMs` (10 s), then fails in words. A crashed writer's lock is broken at once, by one waiter at a time, so two writers never run together. A writer that meets a live breaker at work waits for it under the same deadline, and never blocks its process. Before, a lock was taken once it was 30 s old, from a live writer too, while a writer gave up after 10 s.
