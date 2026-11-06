---
packages: @parcha/agentrun-computer
kind: feature
---
A process keeps running across calls and connections: `process.start` (argv, with an optional pty and stdin), `process.read` by byte offset with an optional bounded wait, `process.write`, `process.signal` (`TERM`, `INT`, `KILL`, `HUP` to the program's group), `process.resize`, `process.list` and `process.wait`. Hello's capabilities gain `processes`.
- `computerd init` now serves the protocol on a unix socket (`/run/agentrun/computerd.sock`, socket 0600) with one process table for every connection, and `computerd stdio` is a bridge to it that fails in words when no daemon listens. `DockerProvider.connect()` is unchanged. Init needs the socket's directory there already, the daemon's user's alone (0700) and writable, and exits 1 in words otherwise; `DockerProvider.create()` mounts `/run/agentrun` as a tmpfs owned by the computer's uid:gid, mode 0700, `noexec,nosuid,nodev`.
- Each stream keeps its last 8 MiB; a read below the ring's start reports the bytes `dropped`. The table holds 256 processes; the one that ended first is dropped for a new start, which is refused as `limit` when all 256 run.
- Every method names a signal the same way, without `SIG` (`"TERM"`, `"KILL"`): `exec.run`, `process.wait` and `process.list`.
- `process.list {offset?}` answers `{processes, truncated}` in pages of at most 768 KiB, and lists at most 64 KiB of each argv (`argvClipped` when cut); `listProcesses` pages it whole.
- Init also ends an orphan whose guard died (a program can kill its own guard), with everything under it, and on SIGTERM, or at its `--deadline`, ends every process and exits 0. `readAll` pages a stream until its process ends.
