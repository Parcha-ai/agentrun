---
packages: @parcha/agentrun-computer
kind: feature
---
computerd's process surface takes what a background shell tool needs, with no script run in the computer.
- `process.start` takes `log`: an absolute path for a new file the daemon makes and writes the first 16 MiB of the output to, stdout and stderr as they come. It makes the missing directories and the file itself and never follows a link (each directory entered with `O_NOFOLLOW|O_DIRECTORY`, the file made with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0644): a link at the path or at a directory on its way is refused as `denied`, a file already there as `exists`, and nothing starts.
- `process.read` reads the `log` stream from the daemon's own open file, never by path, and says when the log was `capped`; every read answers `size`, the stream's bytes so far.
- `process.start` takes `waitGroup` (the process runs until its program and every process left in its group, on a terminal its session, have ended, and reports the program's own exit) and `orphans: "keep"` (what it started outside that runs on, unsignalled, to the computer's end).
- Conformance cases `process.log`, `process.log-links`, `process.wait-group` and `process.orphans-keep`.
