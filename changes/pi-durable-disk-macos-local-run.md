---
packages: @parcha/pi-durable-disk
kind: feature
---
**A run on a local directory works on macOS, for development, and the README says what it costs**
- `localRun`, the no-key quickstart and `run --dir` / `status --dir` run on macOS. There is no `/proc` there, so the
  process table comes from `ps` and `sysctl`: the commands a killed instance left running are recorded and ended at the
  next open as on Linux (a walk every 0.5 s, `ps -E` for a command's mark, a process told from a later one by the second
  it started), the lease watchdog kills the commands at a lapse, and `status --dir` knows its holder by pid and start.
  Before, the open threw (`/proc/self/fd`), and with no boot id the commands went unrecorded.
- On macOS the run's root is addressed by its path (`openClaimDir`'s new `byPath`, its default there), each write
  checked first against the directory opened; `noNewPrivs` defaults to false (no `no_new_privs` there, so commands keep
  the user's rights); and `confineFiles` defaults to false, said once on stderr. An app that passes either option keeps
  its choice.
- The store also sets SQLite's `fullfsync` and `checkpoint_fullfsync` on macOS, where `fsync` does not flush the drive's
  cache, and refuses to open (`StorePragmaError`) unless they read back.
- `currentBootId()` and `procStartTicks()` read the same table: on macOS the boot session's uuid, and the second a
  process started.
- A `macos-latest` CI job runs the stranger's no-key quickstart and the local run's tests on a Mac.
- `status --dir` says `unknown` when this machine's boot or process listing cannot be read, where it said `gone` or
  `stopped`.
