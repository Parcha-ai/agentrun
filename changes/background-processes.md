---
packages: @parcha/agentrun-serve
kind: feature
---
Background processes in a sandbox: an agent whose place is a sandbox may name `bash_background`, `bash_output`, `bash_input`, `bash_signal` and `bash_list`, to start a command that outlives one call (a dev server, a watcher, a long build), read its output in pages, write to its stdin, signal it and list what runs.
- `bash_background {command}` answers the process's id at once. Its stdout and stderr go to `work/background/<id>/output.log`, beside its `pid` and, once it ends, its `exit` code, so the run's files show each log during the run and after it.
- `bash_output {id, offset?, max_bytes?}` reads the log from a byte offset, at most 48 KiB a call, with whether the process still runs, its exit code, the log's size and the next offset. `bash_input {id, text, close?}` writes its stdin; `bash_signal {id, signal}` sends its process group `TERM`, `INT` or `KILL`.
- At most 8 run at once in a run's box, and each log keeps the first 16 MiB of the output: a ninth start is refused in words.
- The run's end ends every one of them (`TERM`, then `KILL` after 3 s) before its box is copied back and destroyed, and each log stays in the run's files.
- Each call is one short command in the box, on the same path as `bash`, so they work on every box that runs `bash`, and the permission gate takes each call as it takes `bash`'s.
