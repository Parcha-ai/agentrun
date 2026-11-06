---
packages: @parcha/agentrun-serve
kind: fix
---
A background process's display copies in `work/background/<id>/` hold up in three more corners.
- Where the copy cannot read random bytes for its temporary file's name (`od` failing, no `/dev/urandom`), it is skipped at once. It used to fall back to a name that is the same every time for a shell, where a FIFO planted by a running command could hang the start, the process's exit and the run's end for their whole timeouts.
- At the run's end, `pid`, `tty` and `capped` are written again too, along with `command`, `started`, `exit` and `ended`, so no link planted at a display name stays in the run's files after the box is gone.
- A write that fails after the temporary file was opened (a full disk) removes that file.
